#!/usr/bin/env node
/**
 * Import the ad landing pages into Strapi.
 *
 *   npm run wp:landing              # import / update all of them
 *   npm run wp:landing -- --dry     # report what would happen, write nothing
 *   npm run wp:landing -- --prune   # also DELETE entries the markdown no
 *                                   # longer has a file for
 *
 * Pruning is opt-in, and deliberately so. A slug rename looks identical to
 * "somebody added a landing page in the admin panel" from in here, and
 * deleting the firm's work is worse than leaving a stale entry behind. The
 * orphans are always reported; removing them is a decision someone has to
 * make on purpose.
 *
 * Boots Strapi in-process, so the server must be STOPPED before running this.
 *
 * WHY THE MARKDOWN STILL EXISTS
 * -----------------------------
 * The copy was written as markdown and reviewed as .docx and .pdf before it
 * went anywhere near the CMS. Those files are the SEED, in the same way the
 * scraped WordPress content seeds everything else: authored outside, imported
 * once, and edited in the admin panel from then on.
 *
 * THE SAME HARD RULE AS wp:import APPLIES
 * Once the firm edits a landing page in the admin panel, running this again
 * overwrites it. Re-run only to seed a fresh database, or accept losing the
 * edits. This is why it is a separate script rather than part of wp:import —
 * the landing pages are campaign assets and will be edited far more often
 * than the migrated pages.
 *
 * The hero image is resolved from the same media map the rest of the import
 * uses, so a landing page points at the identical uploaded file as the
 * homepage rather than a second copy.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// The CJS entry, deliberately — the .mjs build directory-imports lodash/fp,
// which Node's ESM resolver rejects outright.
const require = createRequire(import.meta.url);
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const MIGRATION = path.join(import.meta.dirname, '..');
const OUT = path.join(MIGRATION, 'out');
const DRY = process.argv.includes('--dry');
const PRUNE = process.argv.includes('--prune');

/**
 * The markdown lives in the WEB repo, beside the pages it was written for.
 * Overridable, because the two repos are not guaranteed to be siblings on a
 * server.
 */
const LANDING_DIR =
  process.env.LANDING_CONTENT_DIR ??
  path.join(MIGRATION, '..', '..', 'fakhernco-web', 'content', 'landing');

/**
 * The brand photography, in the order the homepage single type holds it:
 * hero first, then its four section images. The markdown's `image:` is an
 * index into this list.
 */
const PHOTOS = [
  '2026/01/business-team-in-dubai-2025-03-18-15-08-40-utc-scaled.jpg',
  '2026/01/group-business-people-and-lawyers-legal-contract-2025-03-08-13-26-33-utc-scaled.jpg',
  '2026/01/close-up-photo-of-business-woman-and-man-signing-a-2025-04-10-00-26-29-utc-scaled.jpg',
  '2026/01/hand-man-stamping-documents-notary-public-in-offic-2025-03-09-13-11-43-utc-scaled.jpg',
  '2026/01/business-and-lawyers-discussing-contract-papers-wi-2025-12-22-14-21-12-utc-scaled.jpg',
];

/**
 * Markdown -> Strapi dynamic-zone blocks.
 *
 * The source is hard-wrapped, so a lone newline inside a paragraph or a bullet
 * is a soft wrap and must be joined back. Blocks are accumulated and flushed
 * when the NEXT one starts — emitting line by line split every wrapped bullet
 * in half, which is a bug this parser has already had once.
 */
function toBlocks(body) {
  const blocks = [];
  let kind = null;
  let lines = [];

  const inline = (t) =>
    t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  const flush = () => {
    if (!kind || !lines.length) return;
    if (kind === 'ul' || kind === 'ol') {
      blocks.push({
        __component: 'blocks.list',
        ordered: kind === 'ol',
        items: lines.map((t) => ({ text: inline(t) })),
      });
    } else if (kind === 'h2' || kind === 'h3') {
      blocks.push({
        __component: 'blocks.heading',
        level: kind === 'h2' ? 2 : 3,
        text: lines.join(' ').replace(/\*\*/g, ''),
      });
    } else {
      blocks.push({ __component: 'blocks.paragraph', html: inline(lines.join(' ')) });
    }
    kind = null;
    lines = [];
  };

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }

    if (line.startsWith('## ')) { flush(); kind = 'h2'; lines = [line.slice(3).trim()]; }
    else if (line.startsWith('### ')) { flush(); kind = 'h3'; lines = [line.slice(4).trim()]; }
    else if (/^\s*[-*]\s+/.test(line)) {
      const item = line.replace(/^\s*[-*]\s+/, '');
      if (kind === 'ul') lines.push(item);
      else { flush(); kind = 'ul'; lines = [item]; }
    } else if (/^\s*\d+\.\s+/.test(line)) {
      const item = line.replace(/^\s*\d+\.\s+/, '');
      if (kind === 'ol') lines.push(item);
      else { flush(); kind = 'ol'; lines = [item]; }
    } else if (kind === 'ul' || kind === 'ol') {
      lines[lines.length - 1] += ` ${line.trim()}`;   // continuation of the item
    } else if (kind) {
      lines.push(line.trim());
    } else {
      kind = 'p';
      lines = [line.trim()];
    }
  }
  flush();
  return blocks;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return [{}, raw];
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return [meta, m[2]];
}

async function main() {
  if (!existsSync(LANDING_DIR)) {
    console.error(`No landing content at ${LANDING_DIR}`);
    console.error('Set LANDING_CONTENT_DIR if the web repo is elsewhere.');
    process.exit(1);
  }

  const files = (await readdir(LANDING_DIR)).filter((f) => f.endsWith('.md')).sort();
  if (!files.length) {
    console.error(`No .md files in ${LANDING_DIR}`);
    process.exit(1);
  }

  const mediaPath = path.join(OUT, 'media-map.json');
  const MEDIA = existsSync(mediaPath) ? JSON.parse(await readFile(mediaPath, 'utf8')) : {};
  const fileIdFor = (i) => MEDIA[`https://fakhernco.com/wp-content/uploads/${PHOTOS[i] ?? PHOTOS[0]}`] ?? null;

  const docs = [];
  for (const f of files) {
    const [meta, body] = parseFrontmatter(await readFile(path.join(LANDING_DIR, f), 'utf8'));
    const slug = meta.slug ?? f.replace(/\.md$/, '');
    const blocks = toBlocks(body);
    docs.push({ slug, meta, blocks, imageIndex: Number(meta.image) || 0 });
    console.log(
      `  ${slug.padEnd(34)} ${String(blocks.length).padStart(3)} blocks   "${(meta.h1 ?? '').slice(0, 46)}"`,
    );
  }

  if (DRY) {
    console.log(`\n--dry: ${docs.length} landing page(s) would be written. Nothing changed.`);
    return;
  }

  const app = await createStrapi(await compileStrapi()).load();
  const UID = 'api::landing-page.landing-page';
  let created = 0;
  let updated = 0;
  let orphans = [];

  try {
    for (const [i, d] of docs.entries()) {
      const data = {
        title: d.meta.title ?? d.slug,
        slug: d.slug,
        h1: d.meta.h1 ?? d.meta.title ?? d.slug,
        subhead: d.meta.subhead ?? null,
        order: i,
        heroImage: fileIdFor(d.imageIndex),
        seo: d.meta.description
          ? { metaTitle: d.meta.h1 ?? d.meta.title, metaDescription: d.meta.description }
          : null,
        blocks: d.blocks,
      };

      const existing = await app.documents(UID).findFirst({ filters: { slug: d.slug }, locale: 'en' });
      if (existing) {
        await app.documents(UID).update({
          documentId: existing.documentId, locale: 'en', status: 'published', data,
        });
        updated += 1;
      } else {
        await app.documents(UID).create({ locale: 'en', status: 'published', data });
        created += 1;
      }
    }

    // Anything in the CMS with no markdown behind it. Usually a slug rename;
    // occasionally a page the firm added themselves, which is exactly why
    // this does not delete without being asked.
    const seeded = new Set(docs.map((d) => d.slug));
    const all = await app.documents(UID).findMany({ locale: 'en', fields: ['slug'], limit: 500 });
    orphans = all.filter((r) => !seeded.has(r.slug));

    if (orphans.length && PRUNE) {
      for (const o of orphans) {
        await app.documents(UID).delete({ documentId: o.documentId });
      }
    }
  } finally {
    await app.destroy();
  }

  console.log(`\ncreated ${created}, updated ${updated}`);
  if (orphans.length) {
    console.log(
      PRUNE
        ? `pruned ${orphans.length}: ${orphans.map((o) => o.slug).join(', ')}`
        : `\n  ${orphans.length} entr(y/ies) in the CMS have no markdown file:\n` +
            orphans.map((o) => `    ${o.slug}`).join('\n') +
            '\n  Left in place. Re-run with --prune to delete them.',
    );
  }
  const withImage = docs.filter((d) => fileIdFor(d.imageIndex)).length;
  console.log(`hero images linked: ${withImage}/${docs.length}`);
  if (withImage < docs.length) {
    console.log('  Some heroes are unlinked — run npm run wp:media first.');
  }
}

main().catch((e) => {
  console.error('import-landing failed:', e);
  process.exit(1);
});
