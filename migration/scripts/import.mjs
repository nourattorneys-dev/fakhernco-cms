#!/usr/bin/env node
/**
 * Import the extracted WordPress content into Strapi.
 *
 * Boots Strapi in-process and writes through the Document Service, so the
 * server must be STOPPED before running this.
 *
 *   npm run wp:import           # import everything
 *   npm run wp:import -- --dry  # report what would happen, write nothing
 *
 * The consolidation map is authoritative about what gets imported:
 *
 *   keep      -> Page (or Practice area, for the five pillars)
 *   convert   -> Insight or Case study, URL preserved
 *   redirect  -> NOT IMPORTED. It becomes a 301; importing it would recreate
 *                the duplicate we are trying to remove.
 *   delete    -> NOT IMPORTED.
 *   review    -> imported as a DRAFT, so the firm can see it while deciding
 *                without it being publicly reachable.
 *
 * Idempotent: everything upserts by slug, so a re-run after fixing the
 * extractor updates in place rather than duplicating.
 *
 * ONE HARD RULE: once the firm starts editing in the admin panel, this script
 * must not be run against that database again. It overwrites whole records,
 * so it would silently revert their work. Re-import only into a fresh
 * database, or accept losing edits.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Load Strapi through the CommonJS entry deliberately.
 *
 * `import ... from '@strapi/strapi'` resolves Strapi's .mjs build, which does
 * a directory import of `lodash/fp`. Node's ESM resolver rejects that outright
 * with ERR_UNSUPPORTED_DIR_IMPORT, so the whole script dies before it runs.
 * The CJS build resolves the same dependency fine.
 */
const require = createRequire(import.meta.url);
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const MIGRATION = path.join(import.meta.dirname, '..');
// Strapi's appDir must be the project root — where package.json and config/
// live — not the migration folder these scripts sit in.
const PROJECT = path.join(MIGRATION, '..');
const CONTENT = path.join(MIGRATION, 'data', 'content');
const RAW = path.join(MIGRATION, 'data', 'raw');
const OUT = path.join(MIGRATION, 'out');
const DRY = process.argv.includes('--dry');

/** The five pillars become Practice areas rather than plain Pages. */
const PILLARS = [
  'litigation-dispute-resolution',
  'personal-criminal-legal-services',
  'contracts-legal-document-drafting',
  'company-formation-corporate-services',
  'private-notary-attestation-services',
];

/** Nav entries that are routes in the new site, not CMS pages. */
const ROUTE_SLUGS = new Set(['legal-insights', 'contact-us', 'home']);

// --------------------------------------------------------------- utilities

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/**
 * Group the mega-menu into pillar -> children.
 *
 * /wp-json/wp/v2/menus is 401 without auth, so the rendered homepage is the
 * only machine-readable source. Link order encodes the hierarchy: a pillar is
 * followed by its own children until the next pillar appears.
 */
async function navGroups() {
  const html = await readFile(path.join(RAW, 'home-en.html'), 'utf8');
  const paths = [...html.matchAll(/<a\s[^>]*href=["']?(https:\/\/fakhernco\.com\/[^"'\s>#?]*)/g)]
    .map((m) => new URL(m[1]).pathname)
    .filter((p) => !p.startsWith('/ar/'));

  const seen = new Set();
  const ordered = paths.filter((p) => (seen.has(p) ? false : seen.add(p)));

  const parentOf = new Map();
  let current = null;
  for (const p of ordered) {
    const slug = p.replace(/^\/|\/$/g, '');
    if (PILLARS.includes(slug)) { current = slug; continue; }
    if (ROUTE_SLUGS.has(slug) || !slug) { current = null; continue; }
    if (current) parentOf.set(slug, current);
  }

  // The About group: everything between /about-us/ and /services/ in menu
  // order. Without this those three pages are orphaned — /why-choose-fakherco/
  // ended up with no inbound link at all in the rebuild.
  const start = ordered.indexOf('/about-us/');
  const end = ordered.indexOf('/services/');
  const about =
    start >= 0 && end > start
      ? ordered.slice(start + 1, end).map((p) => p.replace(/^\/|\/$/g, ''))
      : [];

  return { parentOf, about };
}

// ----------------------------------------------------------- block mapping

/** legacy WordPress URL -> uploaded Strapi file id, from migrate-media.mjs. */
let MEDIA = {};

/** Longer than this and it is prose, not a heading. Column limit is 255. */
const HEADING_MAX = 200;

const COMPONENT = {
  heading: 'blocks.heading',
  paragraph: 'blocks.paragraph',
  list: 'blocks.list',
  table: 'blocks.data-table',
  faq: 'blocks.faq',
  cards: 'blocks.cards',
  image: 'blocks.image',
  gallery: 'blocks.gallery',
  button: 'blocks.button',
  quote: 'blocks.quote',
};

/**
 * Map an extracted block onto a Strapi dynamic-zone component.
 *
 * Heading levels are clamped to 2-4. The extractor found 49 documents with
 * more than one H1 (one has seven), because the theme lets the author pick the
 * tag per block. The page template owns the H1 now, so a stray H1 in imported
 * content is demoted rather than carried across.
 */
function toComponent(block, stats) {
  const __component = COMPONENT[block.type];
  if (!__component) { stats.skipped.push(block.type); return null; }

  switch (block.type) {
    case 'heading': {
      // A "heading" longer than this is a paragraph the theme happened to
      // render inside a headline block. Storing it as a heading would both
      // overflow the 255-char string column and produce nonsense document
      // outlines, so reclassify rather than truncate — truncating would lose
      // content silently.
      if ((block.text ?? '').length > HEADING_MAX) {
        stats.headingsToParagraph += 1;
        return { __component: COMPONENT.paragraph, html: block.text };
      }
      const level = Math.min(4, Math.max(2, block.level ?? 2));
      if ((block.level ?? 2) < 2) stats.demotedHeadings += 1;
      return { __component, level, text: block.text };
    }
    case 'paragraph':
      return { __component, html: block.html };
    case 'list':
      return {
        __component,
        ordered: Boolean(block.ordered),
        items: (block.items ?? []).map((text) => ({ text })),
      };
    case 'table':
      return { __component, headers: block.headers ?? [], rows: block.rows ?? [] };
    case 'faq':
      return {
        __component,
        items: (block.items ?? []).map(({ question, answer }) => ({ question, answer })),
      };
    case 'cards':
      return {
        __component,
        items: (block.items ?? []).map(({ title, text, href }) => ({
          title, text: text ?? null, href: href ?? null,
        })),
      };
    case 'image': {
      // migrate-media.mjs maps legacy WordPress URLs onto uploaded Strapi file
      // ids. legacySrc is kept either way, so an image whose file has not been
      // migrated still renders from the origin instead of vanishing.
      const fileId = MEDIA[block.src] ?? null;
      if (fileId) stats.imagesLinked += 1; else if (block.src) stats.imagesUnlinked += 1;
      return { __component, alt: block.alt || null, legacySrc: block.src || null, file: fileId };
    }
    case 'gallery':
      return {
        __component,
        items: (block.items ?? []).map((i) => {
          const fileId = MEDIA[i.src] ?? null;
          if (fileId) stats.imagesLinked += 1; else if (i.src) stats.imagesUnlinked += 1;
          return { alt: i.alt || null, legacySrc: i.src || null, file: fileId };
        }),
      };
    case 'button':
      return { __component, text: block.text, href: block.href };
    case 'quote':
      return { __component, html: block.html, attribution: block.attribution ?? null };
    default:
      return null;
  }
}

const toSeo = (seo) => seo && ({
  metaTitle: seo.metaTitle ?? null,
  metaDescription: seo.metaDescription ?? null,
  canonicalUrl: seo.canonicalUrl ?? null,
  noIndex: Boolean(seo.noIndex),
});

// ------------------------------------------------------------------ import

async function main() {
  if (!existsSync(CONTENT)) {
    console.error('No extracted content. Run: npm run wp:extract');
    process.exit(1);
  }

  const decisions = new Map(
    parseCsv(await readFile(path.join(OUT, 'consolidation-map.csv'), 'utf8'))
      .map((r) => [r.slug, r]),
  );
  const mediaPath = path.join(OUT, 'media-map.json');
  MEDIA = existsSync(mediaPath) ? JSON.parse(await readFile(mediaPath, 'utf8')) : {};
  if (!Object.keys(MEDIA).length) {
    console.warn('No media-map.json — image blocks will keep only legacySrc. Run: npm run wp:media');
  }

  const { parentOf, about: aboutSlugs } = await navGroups();
  const rawCats = JSON.parse(await readFile(path.join(RAW, 'categories.json'), 'utf8'));

  const load = async (kind) => {
    const files = await readdir(path.join(CONTENT, kind));
    return Promise.all(files.map(async (f) =>
      JSON.parse(await readFile(path.join(CONTENT, kind, f), 'utf8'))));
  };
  const pages = await load('pages');
  const posts = await load('posts');

  const stats = { skipped: [], demotedHeadings: 0, headingsToParagraph: 0, imagesLinked: 0, imagesUnlinked: 0, created: {}, updated: {}, ignored: [] };
  const bump = (bucket, uid) => { stats[bucket][uid] = (stats[bucket][uid] ?? 0) + 1; };

  if (DRY) {
    const plan = {};
    for (const p of pages) {
      const d = decisions.get(p.slug);
      const act = d?.action ?? 'keep';
      const target = act === 'convert'
        ? (d.method.includes('case-study') ? 'case-study' : 'post')
        : PILLARS.includes(p.slug) ? 'practice-area' : 'page';
      const key = ['redirect', 'delete'].includes(act) ? `SKIP (${act})` : `${target}${act === 'review' ? ' (draft)' : ''}`;
      plan[key] = (plan[key] ?? 0) + 1;
    }
    plan['post (blog)'] = posts.length;
    console.log('DRY RUN — nothing written\n');
    for (const [k, v] of Object.entries(plan).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
    console.log(`\n  pillar children mapped: ${parentOf.size}`);
    return;
  }

  // compileStrapi() builds the app context and compiles the TypeScript config.
  // Constructing createStrapi() with hand-made paths instead leaves
  // db.config.connection undefined, because config/database.ts is never
  // compiled or read. It must run with cwd at the project root.
  process.chdir(PROJECT);
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  /**
   * Single types need an explicit create-vs-update branch.
   *
   * Calling documents().update() with an undefined documentId is a SILENT
   * NO-OP on a single type — no error, no write, nothing in the admin panel.
   */
  async function upsertSingle(uid, data, locale = 'en') {
    const existing = await app.documents(uid).findFirst({ locale });
    if (existing) {
      await app.documents(uid).update({
        documentId: existing.documentId, locale, data, status: 'published',
      });
      bump('updated', uid);
    } else {
      await app.documents(uid).create({ locale, data, status: 'published' });
      bump('created', uid);
    }
  }

  /** Upsert by slug within a locale. */
  async function upsert(uid, slug, data, { publish = true, locale = 'en' } = {}) {
    const existing = await app.documents(uid).findFirst({ filters: { slug }, locale });
    const status = publish ? 'published' : 'draft';
    if (existing) {
      await app.documents(uid).update({ documentId: existing.documentId, locale, data, status });
      bump('updated', uid);
      return existing.documentId;
    }
    const created = await app.documents(uid).create({ locale, data, status });
    bump('created', uid);
    return created.documentId;
  }

  try {
    // 1. Categories first — posts relate to them.
    const catId = new Map();
    for (const c of rawCats.filter((c) => c.count > 0)) {
      const id = await upsert('api::category.category', c.slug, {
        name: c.name, slug: c.slug, description: c.description || null,
      });
      catId.set(c.slug, id);
    }

    // 2. Practice areas next — pages relate to them.
    const areaId = new Map();
    for (const p of pages.filter((p) => PILLARS.includes(p.slug))) {
      const id = await upsert('api::practice-area.practice-area', p.slug, {
        title: p.title,
        slug: p.slug,
        lead: p.seo?.metaDescription ?? null,
        legacyUrl: p.legacyUrl,
        order: PILLARS.indexOf(p.slug),
        seo: toSeo(p.seo),
        blocks: p.blocks.map((b) => toComponent(b, stats)).filter(Boolean),
      });
      areaId.set(p.slug, id);
    }

    // 3. Pages, insights-from-pages and case studies.
    for (const p of pages) {
      if (PILLARS.includes(p.slug)) continue;
      const d = decisions.get(p.slug);
      const action = d?.action ?? 'keep';

      if (action === 'redirect' || action === 'delete') {
        stats.ignored.push(`${p.slug} (${action})`);
        continue;
      }

      const blocks = p.blocks.map((b) => toComponent(b, stats)).filter(Boolean);
      const common = {
        title: p.title, slug: p.slug, legacyUrl: p.legacyUrl,
        seo: toSeo(p.seo), blocks,
      };

      if (action === 'convert') {
        if (d.method.includes('case-study')) {
          await upsert('api::case-study.case-study', p.slug, {
            ...common, summary: p.seo?.metaDescription ?? null,
          });
        } else {
          await upsert('api::post.post', p.slug, {
            ...common, excerpt: p.seo?.metaDescription ?? null,
          });
        }
        continue;
      }

      const parent = parentOf.get(p.slug);
      await upsert('api::page.page', p.slug, {
        ...common,
        practiceArea: parent ? areaId.get(parent) ?? null : null,
      }, { publish: action !== 'review' });
    }

    // 4. Single types.
    //
    // These have no WordPress equivalent to migrate — the theme built the
    // homepage and the site chrome from builder layout rather than content.
    // Seeded here so the front end reads brand assets from the CMS instead of
    // hardcoding upload paths, and so the firm can change them without a deploy.
    const asset = (legacy) => MEDIA[`https://fakhernco.com/wp-content/uploads/${legacy}`] ?? null;

    await upsertSingle('api::site-setting.site-setting', {
      siteName: 'Fakher & Co',
      tagline: 'Trusted Litigation Specialists',
      logo: asset('2025/12/Fakher-Logo.png'),
      footerText: 'Trusted litigation specialists in the UAE since 2011.',
      aboutLinks: aboutSlugs
        .map((slug) => {
          const page = pages.find((p) => p.slug === slug);
          return page ? { title: page.title, slug } : null;
        })
        .filter(Boolean),
    });

    await upsertSingle('api::homepage.homepage', {
      heroEyebrow: 'Trusted Law Firm in Abu Dhabi & Dubai',
      heroTitle: 'Expert Legal Services in the UAE',
      heroText:
        'We are your dedicated legal partners for litigation, company formation, real estate law and criminal defence across Abu Dhabi and Dubai.',
      heroImage: asset('2026/01/business-team-in-dubai-2025-03-18-15-08-40-utc-scaled.jpg'),
      // Photography for the editorial sections. Only the 2026/01 uploads are
      // current-brand imagery; the 2017/2019 blog-post-*.jpg files are
      // Avantage theme demo stock and are deliberately not used here.
      sectionImages: [
        asset('2026/01/group-business-people-and-lawyers-legal-contract-2025-03-08-13-26-33-utc-scaled.jpg'),
        asset('2026/01/close-up-photo-of-business-woman-and-man-signing-a-2025-04-10-00-26-29-utc-scaled.jpg'),
        asset('2026/01/hand-man-stamping-documents-notary-public-in-offic-2025-03-09-13-11-43-utc-scaled.jpg'),
        asset('2026/01/business-and-lawyers-discussing-contract-papers-wi-2025-12-22-14-21-12-utc-scaled.jpg'),
      ].filter(Boolean),
    });

    // 5. Blog posts.
    for (const p of posts) {
      await upsert('api::post.post', p.slug, {
        title: p.title,
        slug: p.slug,
        excerpt: p.excerpt || p.seo?.metaDescription || null,
        publishedDate: p.date ? p.date.slice(0, 10) : null,
        legacyUrl: p.legacyUrl,
        categories: (p.categories ?? []).map((s) => catId.get(s)).filter(Boolean),
        seo: toSeo(p.seo),
        blocks: p.blocks.map((b) => toComponent(b, stats)).filter(Boolean),
      });
    }
  } finally {
    await app.destroy();
  }

  // ------------------------------------------------------------- report
  console.log('\n=== created ===');
  for (const [uid, n] of Object.entries(stats.created)) console.log(`  ${String(n).padStart(4)}  ${uid}`);
  if (Object.keys(stats.updated).length) {
    console.log('\n=== updated ===');
    for (const [uid, n] of Object.entries(stats.updated)) console.log(`  ${String(n).padStart(4)}  ${uid}`);
  }
  console.log(`\nnot imported (redirect/delete): ${stats.ignored.length}`);
  for (const s of stats.ignored) console.log(`  - ${s}`);
  console.log(`\nH1s demoted to H2:           ${stats.demotedHeadings}`);
  console.log(`over-long headings -> prose: ${stats.headingsToParagraph}`);
  console.log(`images linked to media:      ${stats.imagesLinked}`);
  console.log(`images still origin-only:    ${stats.imagesUnlinked}`);
  if (stats.skipped.length) {
    const t = stats.skipped.reduce((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {});
    console.log(`unmapped block types: ${JSON.stringify(t)}`);
  }
}

main().catch((e) => { console.error('import failed:', e); process.exit(1); });
