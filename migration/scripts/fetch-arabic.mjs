#!/usr/bin/env node
/**
 * Fetch the Arabic pages that are genuinely translated, and extract them.
 *
 *   npm run wp:scan-ar     # first — decides what is worth fetching
 *   npm run wp:fetch-ar
 *
 * Writes data/raw/ar/<slug>.html and data/content/ar/pages/<slug>.json.
 *
 * WHY SCRAPING RATHER THAN A DATABASE EXPORT
 * ------------------------------------------
 * TranslatePress stores translations in its own tables, so /wp-json returns
 * English for /ar/ URLs — which made it look like only a phpMyAdmin export
 * could recover the Arabic. But it translates on OUTPUT, so the rendered page
 * carries it. Measured on /criminal-cases/: the Arabic content region holds
 * 2,864 characters against the English REST payload's 3,684, and is 99%
 * Arabic script.
 *
 * ONLY THE TRANSLATED ONES. 53 of 220 URLs are really translated; the rest
 * serve the English page under an /ar/ path. Importing those would create
 * "Arabic" pages that are actually English, which is worse than having no
 * Arabic version — the switcher would offer a translation that does not exist.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';
import { extract } from './extract-content.mjs';

const MIGRATION = path.join(import.meta.dirname, '..');
const RAW_AR = path.join(MIGRATION, 'data', 'raw', 'ar');
const CONTENT_AR = path.join(MIGRATION, 'data', 'content', 'ar', 'pages');
const OUT = path.join(MIGRATION, 'out');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CONCURRENCY = 5;

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const index = i++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

async function main() {
  const scanPath = path.join(OUT, 'arabic-scan.json');
  const { results } = JSON.parse(await readFile(scanPath, 'utf8')).scannedAt !== undefined
    ? JSON.parse(await readFile(scanPath, 'utf8'))
    : { results: [] };

  const targets = results.filter((r) => r.verdict === 'translated' && r.kind === 'page');
  if (!targets.length) {
    console.error('No translated pages in arabic-scan.json. Run: npm run wp:scan-ar');
    process.exit(1);
  }

  await rm(RAW_AR, { recursive: true, force: true });
  await rm(CONTENT_AR, { recursive: true, force: true });
  await mkdir(RAW_AR, { recursive: true });
  await mkdir(CONTENT_AR, { recursive: true });

  console.log(`fetching ${targets.length} translated Arabic pages…\n`);

  const report = [];

  await mapLimit(targets, CONCURRENCY, async ({ slug }) => {
    const url = `https://fakhernco.com/ar/${slug}/`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) {
      report.push({ slug, error: `HTTP ${res.status}` });
      return;
    }
    const html = await res.text();
    await writeFile(path.join(RAW_AR, `${slug}.html`), html);

    const root = parse(html);
    const content = root.querySelector('.btContent');
    if (!content) {
      report.push({ slug, error: 'no .btContent' });
      return;
    }

    // The same block extractor the English content goes through — the markup
    // inside .btContent is the same bt_bb_* structure.
    const { blocks, unhandled, duplicates } = extract(content.innerHTML);

    // Arabic <title> is the translated one; Yoast's meta is NOT translated on
    // this site, which is one of the live SEO defects. Take the title from the
    // page and leave the description to be written properly later.
    const title = clean(
      root.querySelector('h1')?.text ??
        root.querySelector('.bt_bb_headline_content')?.text ??
        '',
    );

    const record = {
      slug,
      locale: 'ar',
      legacyUrl: `/ar/${slug}/`,
      title,
      blocks,
      unhandled,
    };
    await writeFile(path.join(CONTENT_AR, `${slug}.json`), JSON.stringify(record, null, 2));

    const text = blocks
      .map((b) => b.text ?? b.html ?? (b.items ?? []).map((i) => i.text ?? i).join(' ') ?? '')
      .join(' ')
      .replace(/<[^>]+>/g, '');
    report.push({
      slug,
      blocks: blocks.length,
      chars: text.length,
      arabic: (text.match(/[؀-ۿ]/g) ?? []).length,
      duplicates,
      title,
    });
  });

  const ok = report.filter((r) => !r.error);
  const bad = report.filter((r) => r.error);

  console.log(`extracted ${ok.length}/${targets.length}`);
  if (bad.length) {
    console.log('\nfailed:');
    for (const b of bad) console.log(`  ${b.slug}: ${b.error}`);
  }

  const thin = ok.filter((r) => r.blocks < 3);
  if (thin.length) {
    console.log(`\n${thin.length} page(s) extracted fewer than 3 blocks — check these:`);
    for (const t of thin) console.log(`  /${t.slug}/ (${t.blocks} blocks)`);
  }

  const totalBlocks = ok.reduce((n, r) => n + r.blocks, 0);
  const totalArabic = ok.reduce((n, r) => n + r.arabic, 0);
  console.log(`\n  blocks: ${totalBlocks}  arabic characters: ${totalArabic.toLocaleString()}`);
  console.log(`  written: ${CONTENT_AR}`);
  console.log('\nNow run: npm run wp:import');
}

main().catch((e) => {
  console.error('fetch-arabic failed:', e);
  process.exit(1);
});
