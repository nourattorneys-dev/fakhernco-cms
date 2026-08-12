#!/usr/bin/env node
/**
 * Correct "Fakhir" to "Fakher" wherever it appears.
 *
 *   node scripts/fix-founder-spelling.mjs --dry
 *   node scripts/fix-founder-spelling.mjs                 # local CMS
 *   TARGET=production node scripts/fix-founder-spelling.mjs
 *
 * The founder's surname is spelled the same way as the firm. Four places in
 * the migrated WordPress copy spell it "Fakhir" — including the About page's
 * opening line about the founder, which is close to the worst place on a law
 * firm's site to misspell its own name.
 *
 * Case is preserved so FAKHIR in a heading does not come back title-cased.
 *
 * Only whole-word matches are touched. A substring replace would corrupt
 * fakhernco.com URLs and email addresses if the wrong spelling ever appeared
 * inside one.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const PROD = process.env.TARGET === 'production';
const BASE = PROD ? 'https://cms.fakhernco.com' : 'http://localhost:1337';

let token = '';
if (PROD) token = (await readFile(path.join(import.meta.dirname, '..', '.seed-token'), 'utf8')).trim();
const auth = () => (token ? { Authorization: `Bearer ${token}` } : {});

const TYPES = ['pages', 'posts', 'practice-areas', 'case-studies', 'landing-pages'];
const COMPONENTS = ['blocks.heading', 'blocks.paragraph', 'blocks.list', 'blocks.faq', 'blocks.image', 'blocks.quote'];

function populate() {
  const p = new URLSearchParams({ 'pagination[pageSize]': '200', 'populate[seo]': 'true' });
  for (const c of COMPONENTS) p.set(`populate[blocks][on][${c}][populate]`, '*');
  return p;
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}/api/${url}`, {
    method,
    headers: { ...auth(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 240)}`);
  return res.status === 204 ? null : res.json();
}

/** Whole word only, case preserved. */
const WORD = /\bFakhir\b/gi;
const fixCase = (m) =>
  m === m.toUpperCase() ? 'FAKHER' : m[0] === m[0].toUpperCase() ? 'Fakher' : 'fakher';

let changes = 0;
function fixStrings(value) {
  if (typeof value === 'string') {
    if (!WORD.test(value)) { WORD.lastIndex = 0; return value; }
    WORD.lastIndex = 0;
    const out = value.replace(WORD, fixCase);
    if (out !== value) changes += (value.match(WORD) ?? []).length;
    WORD.lastIndex = 0;
    return out;
  }
  if (Array.isArray(value)) return value.map(fixStrings);
  if (value && typeof value === 'object') {
    const out = {};
    // __component must lead: Strapi identifies the dynamic-zone entry by the
    // first key, and rejects the payload with an unrelated message otherwise.
    if (value.__component) out.__component = value.__component;
    for (const [k, v] of Object.entries(value)) {
      if (k === '__component') continue;
      if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale', 'localizations'].includes(k)) continue;
      out[k] = fixStrings(v);
    }
    return out;
  }
  return value;
}

console.log(`\n${DRY ? 'DRY RUN — ' : ''}target: ${BASE}\n`);
let touched = 0;

for (const type of TYPES) {
  for (const locale of ['en', 'ar']) {
    let rows;
    try {
      rows = (await api('GET', `${type}?${populate()}&locale=${locale}`)).data ?? [];
    } catch { continue; }

    for (const row of rows) {
      const before = changes;
      const data = fixStrings({ ...row });
      if (changes === before) continue;

      console.log(`  ${type}/${locale}  ${row.slug}  (${changes - before} fixed)`);
      touched += 1;
      if (!DRY) {
        await api('PUT', `${type}/${row.documentId}?locale=${locale}&status=published`, { data });
      }
    }
  }
}

console.log(`\n${DRY ? 'would fix' : 'fixed'} ${changes} occurrence(s) across ${touched} entr(y/ies)\n`);
