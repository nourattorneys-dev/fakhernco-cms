#!/usr/bin/env node
/**
 * Measure how much of the site is actually translated into Arabic.
 *
 *   node migration/scripts/scan-arabic.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * TranslatePress keeps translations in its own database tables, not in
 * post_content, so the REST API returns English for /ar/ URLs and it looked
 * like the Arabic could only be recovered via a database export.
 *
 * That is only true of the API. TranslatePress translates on OUTPUT, so the
 * rendered HTML at /ar/<slug> carries the Arabic — and for a translated page
 * it carries essentially the same content as the REST API does for English
 * (measured: 2,864 vs 3,684 characters on /criminal-cases/).
 *
 * So Arabic is recoverable by scraping. What is NOT known without measuring
 * is how much of it exists, because coverage is wildly uneven: some pages are
 * fully translated, most are not.
 *
 * MEASURE THE CONTENT REGION, NOT THE PAGE. An /ar/ page is mostly English
 * chrome — nav, footer, cookie banner — so measuring whole-page text badly
 * understates translated pages and was how an earlier pass concluded the
 * Arabic was 14% complete when the article bodies were 99%.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';

const MIGRATION = path.join(import.meta.dirname, '..');
const RAW = path.join(MIGRATION, 'data', 'raw');
const OUT = path.join(MIGRATION, 'out');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Above this share of Arabic letters, a page is worth importing. */
const FULL = 0.85;
/** Below this, it is simply the English page served under an /ar/ URL. */
const PARTIAL = 0.4;

const CONCURRENCY = 6;

async function measure(slug) {
  const url = `https://fakhernco.com/ar/${slug}/`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) return { slug, status: res.status, verdict: 'error' };

    const root = parse(await res.text());
    const content = root.querySelector('.btContent');
    const text = (content?.text ?? '').replace(/\s+/g, ' ').trim();

    const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    const share = arabic / Math.max(arabic + latin, 1);

    return {
      slug,
      status: res.status,
      chars: text.length,
      arabic,
      latin,
      share: Number(share.toFixed(3)),
      verdict: share >= FULL ? 'translated' : share >= PARTIAL ? 'partial' : 'english',
    };
  } catch (err) {
    return { slug, status: 0, verdict: 'error', error: err.message };
  }
}

/** Bounded concurrency — this is someone's production server. */
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

async function main() {
  const pages = JSON.parse(await readFile(path.join(RAW, 'pages.json'), 'utf8'));
  const posts = JSON.parse(await readFile(path.join(RAW, 'posts.json'), 'utf8'));

  const targets = [
    ...pages.map((p) => ({ kind: 'page', slug: p.slug })),
    ...posts.map((p) => ({ kind: 'post', slug: p.slug })),
  ];

  console.log(`scanning ${targets.length} Arabic URLs at concurrency ${CONCURRENCY}…\n`);
  const results = await mapLimit(targets, CONCURRENCY, async (t) => ({
    ...t,
    ...(await measure(t.slug)),
  }));

  const by = (kind, verdict) =>
    results.filter((r) => r.kind === kind && r.verdict === verdict);

  for (const kind of ['page', 'post']) {
    const all = results.filter((r) => r.kind === kind);
    console.log(`=== ${kind.toUpperCase()}S (${all.length}) ===`);
    for (const v of ['translated', 'partial', 'english', 'error']) {
      const n = by(kind, v).length;
      if (n) console.log(`  ${v.padEnd(11)} ${n}`);
    }
    const good = by(kind, 'translated');
    if (good.length) {
      console.log('  translated:');
      for (const r of good.sort((a, b) => b.share - a.share)) {
        console.log(`    ${(r.share * 100).toFixed(0).padStart(3)}%  ${r.chars.toString().padStart(6)} chars  /${r.slug}/`);
      }
    }
    console.log();
  }

  const importable = results.filter((r) => r.verdict === 'translated');
  await writeFile(
    path.join(OUT, 'arabic-scan.json'),
    JSON.stringify({ scannedAt: null, results }, null, 2) + '\n',
  );

  console.log(`worth importing: ${importable.length} of ${results.length}`);
  console.log(`written: ${path.join(OUT, 'arabic-scan.json')}`);
}

main().catch((e) => {
  console.error('scan-arabic failed:', e);
  process.exit(1);
});
