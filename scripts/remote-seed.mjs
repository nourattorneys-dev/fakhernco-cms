#!/usr/bin/env node
/**
 * Seed the REMOTE Strapi over its REST API, from this machine.
 *
 *   node scripts/remote-seed.mjs https://cms.fakhernco.com
 *   node scripts/remote-seed.mjs https://cms.fakhernco.com --dry-run
 *
 * WHY THIS EXISTS
 * ---------------
 * The documented import (npm run wp:fetch -> wp:extract -> wp:import) scrapes
 * the live WordPress site and writes straight to the database. Neither half is
 * available any more: WordPress was taken down on 11 Aug 2026, and there is no
 * shell on the server. What survives is the LOCAL Strapi, which already holds
 * the finished import — so this copies that to the remote over REST.
 *
 * WHY NOT `strapi transfer`
 * -------------------------
 * It overwrites admin::user, admin::role and admin::transfer-token on the
 * destination. The local database has NO admin user, so a transfer would empty
 * the remote's admin table and lock the developer out of the CMS — and delete
 * the token it was authenticating with on the way past. This script only ever
 * writes our own content types and the media library.
 *
 * WHY IT READS FROM THE LOCAL STRAPI RATHER THAN migration/data
 * ------------------------------------------------------------
 * Because everything the importer does — block mapping, link repair, the
 * consolidation decisions, heading clamping, the Arabic localisations, the
 * practice-area relations — has already been done, and the local site renders
 * correctly from the result. Re-deriving it here would mean a second copy of
 * that logic, free to drift from the first. The local API is the proven
 * artefact; this is a copy, not a re-import.
 *
 * Idempotent: everything is matched on slug and updated in place, so an
 * interrupted run can simply be run again.
 *
 * NEVER SEEDS contact-submission. Those are real enquiries from real people on
 * the production site; the local ones are test rows and must not land there.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const UPLOADS = path.join(ROOT, 'public', 'uploads');

const TARGET = (process.argv.find((a) => a.startsWith('http')) ?? '').replace(/\/$/, '');
const SOURCE = (process.env.SOURCE_URL ?? 'http://localhost:1337').replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');

if (!TARGET) {
  console.error('Usage: node scripts/remote-seed.mjs <https://cms.example.com> [--dry-run]');
  process.exit(2);
}

/**
 * The token, read from a file rather than the command line.
 *
 * Strapi tokens are 256 characters and routinely contain characters the shell
 * treats as operators, so pasting one as an argument tends to fail in ways that
 * look like a bug in this script.
 */
function resolveToken() {
  const file = path.join(ROOT, '.seed-token');
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  if (process.env.STRAPI_TOKEN?.trim()) return process.env.STRAPI_TOKEN.trim();
  console.error(`No token found.

Save it to  fakhernco-cms/.seed-token  (gitignored), or set STRAPI_TOKEN.

Create it in the remote admin:
  Settings -> API Tokens -> Create new API Token
  Token type: Full access      (it needs create + update on every type)`);
  process.exit(2);
}
const TOKEN = resolveToken();

/* ----------------------------------------------------------------- transport */

let calls = 0;
async function req(base, method, endpoint, body, opts = {}) {
  calls += 1;
  const url = `${base}/api/${endpoint.replace(/^\//, '')}`;
  const headers = {};
  if (base === TARGET) headers.Authorization = `Bearer ${TOKEN}`;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* proxy HTML error page */ }
  if (!res.ok && !opts.allow?.includes(res.status)) {
    throw new Error(`${method} ${endpoint} -> ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
  }
  return json;
}
const src = (endpoint, opts) => req(SOURCE, 'GET', endpoint, null, opts);
const dst = (method, endpoint, body, opts) => req(TARGET, method, endpoint, body, opts);

const q = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

/**
 * Explicit populate for the dynamic zone.
 *
 * `populate=deep` is a Strapi v4 plugin idiom and v5 rejects it outright with
 * "Invalid key deep". A dynamic zone needs the `on` syntax, naming each
 * component — a bare `populate[blocks]=*` returns the components without their
 * own nested relations, which silently drops every image, card and list item.
 */
const BLOCK_COMPONENTS = [
  'blocks.heading', 'blocks.paragraph', 'blocks.list', 'blocks.data-table',
  'blocks.faq', 'blocks.cards', 'blocks.image', 'blocks.button',
  'blocks.quote', 'blocks.gallery',
];
const POPULATE = {
  // `populate[seo]=*` is rejected: the component holds an ogImage media field
  // and the bare asterisk trips over it with "Invalid key ogImage at
  // seo.ogImage". Naming the nested populate is what v5 wants.
  'populate[seo][populate]': '*',
  ...Object.fromEntries(
    BLOCK_COMPONENTS.map((c) => [`populate[blocks][on][${c}][populate]`, '*']),
  ),
};

/**
 * Read every page of a collection.
 *
 * POPULATE is opt-in per call rather than always applied: `categories` has no
 * `blocks` field, and asking for it there is a 400 "Invalid key blocks" rather
 * than being ignored.
 */
async function readAll(type, extra = {}) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const r = await src(
      `${type}?${q({ 'pagination[page]': page, 'pagination[pageSize]': 50, ...extra })}`,
    );
    out.push(...(r.data ?? []));
    const pc = r.meta?.pagination?.pageCount ?? 1;
    if (page >= pc) break;
  }
  return out;
}

/* -------------------------------------------------------------------- media */

/**
 * Upload every local file and map local id -> remote id.
 *
 * Matched on filename: a re-run reuses what is already there rather than
 * uploading 34 duplicates.
 */
/**
 * The local media library.
 *
 * NOT via the API: `upload/files` is an admin-scoped endpoint, and the local
 * Strapi's public role has no permission for it — it answers 500, not 403,
 * which makes it look like the server is broken rather than the request being
 * unauthorised. The remote works only because it has a token. Reading the
 * local database directly avoids granting a permission on the dev instance
 * purely so this script can run.
 */
function readLocalFiles() {
  const db = path.join(ROOT, process.env.DATABASE_FILENAME ?? '.tmp/data.db');
  if (!fs.existsSync(db)) {
    throw new Error(`Local database not found at ${db}`);
  }
  const sql =
    "SELECT id || '\t' || name || '\t' || url || '\t' || COALESCE(alternative_text,'') FROM files;";
  const out = execFileSync('sqlite3', [db, sql], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, name, url, alternativeText] = line.split('\t');
      return { id: Number(id), name, url, alternativeText: alternativeText || null };
    });
}

async function seedMedia() {
  const local = readLocalFiles();

  const remoteFiles = await dst('GET', 'upload/files?pagination[pageSize]=500', null, { allow: [404] });
  const remote = Array.isArray(remoteFiles) ? remoteFiles : (remoteFiles?.results ?? []);
  const byName = new Map(remote.map((f) => [f.name, f]));

  const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif',
  };

  const map = new Map();
  let uploaded = 0, reused = 0;
  const failed = [];

  for (const f of local) {
    if (byName.has(f.name)) {
      map.set(f.id, byName.get(f.name).id);
      reused += 1;
      continue;
    }
    if (DRY) continue;

    // The binary as stored by the local Strapi. url is like /uploads/name.ext
    const onDisk = path.join(UPLOADS, path.basename(f.url));
    try {
      const buf = fs.existsSync(onDisk)
        ? fs.readFileSync(onDisk)
        : Buffer.from(await (await fetch(`${SOURCE}${f.url}`)).arrayBuffer());

      const fd = new FormData();
      const ext = f.name.split('.').pop().toLowerCase();
      fd.append('files', new Blob([buf], { type: MIME[ext] ?? 'application/octet-stream' }), f.name);
      if (f.alternativeText) fd.append('fileInfo', JSON.stringify({ alternativeText: f.alternativeText }));

      const rec = await dst('POST', 'upload', fd);
      const r0 = Array.isArray(rec) ? rec[0] : rec;
      map.set(f.id, r0.id);
      byName.set(r0.name, r0);
      uploaded += 1;
      if (uploaded % 10 === 0) console.log(`    uploaded ${uploaded}`);
    } catch (e) {
      failed.push([f.name, e.message]);
    }
  }

  console.log(`  media: uploaded ${uploaded}, reused ${reused}, failed ${failed.length}`);
  failed.slice(0, 5).forEach(([n, m]) => console.log(`    FAIL ${n} — ${m}`));
  return map;
}

/* ------------------------------------------------------------------ mapping */

/**
 * Prepare a value read from one Strapi for writing to another.
 *
 * Strips ids — reusing component ids from another entity is rejected as
 * "components not related to this entity" — and swaps populated media objects
 * for the destination's numeric file id.
 *
 * KEY ORDER IS LOAD-BEARING. `__component` must be the FIRST key of a dynamic
 * zone entry. Strapi validates keys in the order they appear, so if it reaches
 * a nested `items` array before it knows which component schema applies, it
 * cannot validate them and rejects the write with "Invalid key __component at
 * blocks" — an error that points at the one key that is actually correct.
 * Components without nested repeatables happen to survive either order, which
 * is what makes this look intermittent.
 */
function stripIds(value, mediaMap) {
  if (Array.isArray(value)) return value.map((v) => stripIds(v, mediaMap));
  if (value && typeof value === 'object') {
    const out = {};
    if (value.__component) out.__component = value.__component;
    for (const [k, v] of Object.entries(value)) {
      // Read-only metadata. `localizations` and `locale` in particular come
      // back from populate=* and are rejected on write — the locale is a query
      // parameter, not a field.
      if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt',
           'locale', 'localizations'].includes(k)) continue;
      // A populated media object becomes the remote file's numeric id.
      const isMedia = (x) => x && typeof x === 'object' && x.mime && x.url;
      if (isMedia(v)) {
        const remoteId = mediaMap.get(v.id);
        if (remoteId) out[k] = remoteId;
        continue;
      }
      // ...and a multiple-media field becomes an array of them. Missing this
      // sent the homepage's sectionImages through as whole file objects, which
      // Strapi rejects with a bare "Invalid relations".
      if (Array.isArray(v) && v.length && v.every(isMedia)) {
        out[k] = v.map((m) => mediaMap.get(m.id)).filter(Boolean);
        continue;
      }
      out[k] = stripIds(v, mediaMap);
    }
    return out;
  }
  return value;
}

/** Create or update by slug, in a given locale. Returns the documentId. */
async function upsert(type, slug, data, { locale = 'en', documentId = null } = {}) {
  if (DRY) return documentId ?? `dry-${slug}`;

  if (documentId) {
    // A localisation attaches to an existing document rather than making a new one.
    await dst('PUT', `${type}/${documentId}?${q({ locale, status: 'published' })}`, { data });
    return documentId;
  }
  const found = await dst(
    'GET',
    `${type}?${q({ 'filters[slug][$eq]': slug, 'fields[0]': 'slug', locale, status: 'published' })}`,
  );
  const existing = found?.data?.[0];
  if (existing) {
    await dst('PUT', `${type}/${existing.documentId}?${q({ locale, status: 'published' })}`, { data });
    return existing.documentId;
  }
  const created = await dst('POST', `${type}?${q({ locale, status: 'published' })}`, { data });
  return created.data.documentId;
}

/* --------------------------------------------------------------------- seed */

console.log(`\n  source ${SOURCE}\n  target ${TARGET}${DRY ? '   (dry run)' : ''}\n`);

try {
  await src('pages?pagination[pageSize]=1');
} catch (e) {
  console.error(`Cannot read the LOCAL Strapi at ${SOURCE}. Start it with: npm run develop\n  ${e.message}`);
  process.exit(1);
}
try {
  await dst('GET', 'pages?pagination[pageSize]=1');
} catch (e) {
  console.error(`Cannot read the REMOTE API.\n  ${e.message}\n
A 401/403 means the token is wrong or is not "Full access".
A 404 means the deployed build predates these content types.`);
  process.exit(1);
}

const summary = {};

console.log('  media…');
const mediaMap = await seedMedia();
summary.media = mediaMap.size;

// ---- categories: nothing depends on them but posts do ------------------------
const catId = new Map();
for (const c of await readAll('categories')) {
  const id = await upsert('categories', c.slug, {
    name: c.name, slug: c.slug, description: c.description ?? null,
  });
  catId.set(c.slug, id);
}
summary.categories = catId.size;
console.log(`  categories ${catId.size}`);

// ---- practice areas: pages relate to them, so they go first ------------------
const areaId = new Map();
for (const a of await readAll('practice-areas', POPULATE)) {
  const id = await upsert('practice-areas', a.slug, {
    title: a.title, slug: a.slug, lead: a.lead ?? null, legacyUrl: a.legacyUrl ?? null,
    order: a.order ?? 0, seo: stripIds(a.seo, mediaMap), blocks: stripIds(a.blocks, mediaMap),
  });
  areaId.set(a.slug, id);
}
summary.practiceAreas = areaId.size;
console.log(`  practice areas ${areaId.size}`);

// ---- pages -------------------------------------------------------------------
const pageId = new Map();
const pages = await readAll('pages', { ...POPULATE, 'populate[practiceArea][fields][0]': 'slug' });
for (const [i, p] of pages.entries()) {
  const id = await upsert('pages', p.slug, {
    title: p.title, slug: p.slug, legacyUrl: p.legacyUrl ?? null,
    menuOrder: p.menuOrder ?? 0,
    practiceArea: p.practiceArea?.slug ? areaId.get(p.practiceArea.slug) ?? null : null,
    seo: stripIds(p.seo, mediaMap), blocks: stripIds(p.blocks, mediaMap),
  });
  pageId.set(p.slug, id);
  if ((i + 1) % 20 === 0 || i === pages.length - 1) console.log(`  pages ${i + 1}/${pages.length}`);
}
summary.pages = pageId.size;

// ---- case studies ------------------------------------------------------------
const caseId = new Map();
for (const c of await readAll('case-studies', POPULATE)) {
  const id = await upsert('case-studies', c.slug, {
    title: c.title, slug: c.slug, summary: c.summary ?? null, legacyUrl: c.legacyUrl ?? null,
    seo: stripIds(c.seo, mediaMap), blocks: stripIds(c.blocks, mediaMap),
  });
  caseId.set(c.slug, id);
}
summary.caseStudies = caseId.size;
console.log(`  case studies ${caseId.size}`);

// ---- posts -------------------------------------------------------------------
const postId = new Map();
const posts = await readAll('posts', { ...POPULATE, 'populate[categories][fields][0]': 'slug' });
for (const [i, p] of posts.entries()) {
  const id = await upsert('posts', p.slug, {
    title: p.title, slug: p.slug, excerpt: p.excerpt ?? null,
    publishedDate: p.publishedDate ?? null, legacyUrl: p.legacyUrl ?? null,
    categories: (p.categories ?? []).map((c) => catId.get(c.slug)).filter(Boolean),
    seo: stripIds(p.seo, mediaMap), blocks: stripIds(p.blocks, mediaMap),
  });
  postId.set(p.slug, id);
  if ((i + 1) % 25 === 0 || i === posts.length - 1) console.log(`  posts ${i + 1}/${posts.length}`);
}
summary.posts = postId.size;

// ---- landing pages -----------------------------------------------------------
const landingId = new Map();
for (const l of await readAll('landing-pages', { ...POPULATE, 'populate[heroImage]': 'true' })) {
  const id = await upsert('landing-pages', l.slug, {
    title: l.title, slug: l.slug, h1: l.h1, subhead: l.subhead ?? null, order: l.order ?? 0,
    heroImage: l.heroImage ? mediaMap.get(l.heroImage.id) ?? null : null,
    seo: stripIds(l.seo, mediaMap), blocks: stripIds(l.blocks, mediaMap),
  });
  landingId.set(l.slug, id);
}
summary.landingPages = landingId.size;
console.log(`  landing pages ${landingId.size}`);

// ---- single types ------------------------------------------------------------
if (!DRY) {
  for (const locale of ['en', 'ar']) {
    const home = await src(`homepage?${q({ locale, 'populate[heroImage]': 'true', 'populate[sectionImages]': 'true' })}`, { allow: [404] });
    if (home?.data) {
      await dst('PUT', `homepage?${q({ locale, status: 'published' })}`, {
        data: stripIds({ ...home.data, locale: undefined }, mediaMap),
      });
    }
    // populate=* rather than naming fields: aboutLinks is a json column, not a
      // relation, and asking to populate it is a 400 rather than a no-op.
      const site = await src(`site-setting?${q({ locale, populate: '*' })}`, { allow: [404] });
    if (site?.data) {
      await dst('PUT', `site-setting?${q({ locale, status: 'published' })}`, {
        data: stripIds({ ...site.data, locale: undefined }, mediaMap),
      });
    }
  }
}
summary.singleTypes = 'homepage + site-setting, en + ar';
console.log('  single types');

/* ---------------------------------------------------------- arabic localisations */

/**
 * A localisation attaches to the SAME document as its English counterpart, so
 * the English entry has to exist first — which is why this runs last and reuses
 * the documentIds collected above.
 */
console.log('  arabic…');
let ar = 0;
for (const [type, ids] of [
  ['practice-areas', areaId],
  ['pages', pageId],
  ['posts', postId],
  ['case-studies', caseId],
]) {
  const rows = await readAll(type, { ...POPULATE, locale: 'ar' });
  for (const r of rows) {
    const documentId = ids.get(r.slug);
    if (!documentId) continue;
    await upsert(type, r.slug, {
      title: r.title, slug: r.slug, legacyUrl: r.legacyUrl ?? null,
      seo: stripIds(r.seo, mediaMap), blocks: stripIds(r.blocks, mediaMap),
    }, { locale: 'ar', documentId });
    ar += 1;
  }
}
summary.arabicLocalisations = ar;
console.log(`  arabic ${ar}`);

console.log(`\nDONE — ${calls} API calls`);
for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
console.log(`
Verify from the website repo:
  STRAPI_URL=${TARGET} npm run check:cms

Then check an Arabic page renders correctly — it is the fastest proof that the
remote MySQL database was created as utf8mb4 and not the 3-byte legacy utf8:
  ${TARGET}/api/pages?locale=ar&filters[slug][\\$eq]=criminal-cases`);
