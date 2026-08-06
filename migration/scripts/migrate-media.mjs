#!/usr/bin/env node
/**
 * Download media from the live WordPress origin and upload it into Strapi.
 *
 *   npm run wp:media -- --dry   # list what would be migrated
 *   npm run wp:media            # download + upload (Strapi must be STOPPED)
 *
 * TIME-SENSITIVE. Images are fetched from the live origin, so this has to run
 * before the WordPress site is retired. Once it is gone there is no source.
 *
 * WHAT GETS MIGRATED
 * ------------------
 * Not all 97 library items. Only:
 *   - the 29 images actually referenced by extracted content or OG tags
 *   - everything uploaded in 2025/2026, which is the genuine current-brand
 *     imagery
 * The rest are Avantage theme demo stock from 2017 and 2019 that nothing links
 * to. Migrating them would import someone else's placeholder photography into
 * a law firm's media library.
 *
 * WHY THIS RUNS BEFORE import.mjs
 * -------------------------------
 * It writes out/media-map.json (legacy URL -> Strapi file id) and the importer
 * reads it to set the `file` relation directly. The alternative - importing
 * first and patching image blocks afterwards - means rewriting dynamic zones,
 * and components read back from Strapi carry their own ids which it then
 * rejects on write ("components are not related to the entity").
 */

import { readFile, readdir, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const MIGRATION = path.join(import.meta.dirname, '..');
const PROJECT = path.join(MIGRATION, '..');
const CONTENT = path.join(MIGRATION, 'data', 'content');
const RAW = path.join(MIGRATION, 'data', 'raw');
const OUT = path.join(MIGRATION, 'out');
const DRY = process.argv.includes('--dry');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/**
 * Resolve a WordPress derivative filename back to the original upload.
 *   foo-640x224.png -> foo.png   (generated size)
 *   foo.png.webp    -> foo.png   (Robin Image Optimizer sibling)
 * `-scaled` is kept: that IS the stored file, not a derivative.
 */
const originalUpload = (url) =>
  url
    .replace(/\.(jpe?g|png|gif)\.webp$/i, '.$1')
    .replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|gif|webp))$/i, '$1');

async function collectReferenced() {
  const refs = new Map(); // original URL -> alt text seen with it
  for (const kind of ['pages', 'posts']) {
    for (const f of await readdir(path.join(CONTENT, kind))) {
      const doc = JSON.parse(await readFile(path.join(CONTENT, kind, f), 'utf8'));
      for (const b of doc.blocks) {
        if (b.type === 'image' && b.src) {
          const url = originalUpload(b.src);
          if (!refs.has(url) || (!refs.get(url) && b.alt)) refs.set(url, b.alt || '');
        }
      }
      if (doc.seo?.ogImageUrl) {
        const url = originalUpload(doc.seo.ogImageUrl);
        if (!refs.has(url)) refs.set(url, '');
      }
    }
  }
  return refs;
}

async function main() {
  const referenced = await collectReferenced();
  const library = JSON.parse(await readFile(path.join(RAW, 'media.json'), 'utf8'));

  // Current-brand imagery: everything uploaded from 2025 onwards.
  const brand = library.filter((m) => /\/uploads\/(202[5-9]|20[3-9]\d)\//.test(m.source_url));
  const byUrl = new Map(library.map((m) => [m.source_url, m]));

  const targets = new Map();
  for (const [url, alt] of referenced) {
    targets.set(url, { url, alt: alt || byUrl.get(url)?.alt_text || '', why: 'referenced' });
  }
  for (const m of brand) {
    if (!targets.has(m.source_url)) {
      targets.set(m.source_url, { url: m.source_url, alt: m.alt_text || '', why: 'current brand' });
    }
  }

  const list = [...targets.values()];
  console.log(`referenced by content : ${referenced.size}`);
  console.log(`current-brand assets  : ${brand.length}`);
  console.log(`to migrate            : ${list.length}`);
  console.log(`skipped (unreferenced theme demo stock): ${library.length - brand.length - [...referenced].filter(([u]) => byUrl.has(u)).length}`);

  if (DRY) {
    console.log('\nDRY RUN — nothing downloaded or uploaded\n');
    for (const t of list) {
      console.log(`  [${t.why.padEnd(13)}] ${t.url.replace('https://fakhernco.com/wp-content/uploads/', '')}`);
    }
    return;
  }

  const tmp = path.join(os.tmpdir(), 'fakhernco-media');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  // ---- download ----------------------------------------------------------
  const downloaded = [];
  const failed = [];
  for (const t of list) {
    const name = decodeURIComponent(path.basename(new URL(t.url).pathname));
    const dest = path.join(tmp, name);
    try {
      const res = await fetch(t.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      const { size } = await stat(dest);
      downloaded.push({ ...t, name, dest, size });
    } catch (err) {
      failed.push({ ...t, error: err.message });
    }
  }
  console.log(`\ndownloaded ${downloaded.length}/${list.length}` +
    `  (${(downloaded.reduce((s, d) => s + d.size, 0) / 1048576).toFixed(1)} MB)`);
  for (const f of failed) console.log(`  FAILED ${f.url} — ${f.error}`);

  // ---- upload ------------------------------------------------------------
  process.chdir(PROJECT);
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  const map = {};
  let created = 0, reused = 0;

  try {
    const uploadService = app.plugin('upload').service('upload');

    for (const d of downloaded) {
      const base = path.parse(d.name).name;

      // Idempotent: a re-run must not duplicate the library.
      const existing = await app.db.query('plugin::upload.file').findOne({ where: { name: d.name } });
      if (existing) {
        map[d.url] = existing.id;
        reused += 1;
        continue;
      }

      const [file] = await uploadService.upload({
        data: {
          fileInfo: {
            name: d.name,
            alternativeText: d.alt || base.replace(/[-_]+/g, ' '),
            caption: null,
          },
        },
        files: {
          filepath: d.dest,
          originalFileName: d.name,
          mimetype: MIME[path.extname(d.name).toLowerCase()] ?? 'application/octet-stream',
          size: d.size,
        },
      });
      map[d.url] = file.id;
      created += 1;
    }
  } finally {
    await app.destroy();
  }

  // Index derivative URLs onto the same file so content referencing a
  // "-640x224" variant still resolves.
  const full = { ...map };
  for (const [url, id] of Object.entries(map)) {
    for (const [ref] of referenced) if (originalUpload(ref) === url) full[ref] = id;
  }

  await writeFile(path.join(OUT, 'media-map.json'), JSON.stringify(full, null, 2) + '\n');

  console.log(`\nuploaded ${created}, reused ${reused}`);
  console.log(`media map: ${Object.keys(full).length} URL(s) -> ${new Set(Object.values(full)).size} file(s)`);
  console.log(`written: ${path.join(OUT, 'media-map.json')}`);
  console.log('\nNow re-run the import so image blocks point at the uploaded files:');
  console.log('  npm run wp:import');
}

main().catch((e) => { console.error('migrate-media failed:', e); process.exit(1); });
