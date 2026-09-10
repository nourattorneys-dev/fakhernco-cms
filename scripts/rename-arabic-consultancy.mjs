#!/usr/bin/env node
/**
 * The Arabic half of the "law firm" -> "legal consultancy" rename.
 *
 *   node scripts/rename-arabic-consultancy.mjs --dry
 *   TARGET=production node scripts/rename-arabic-consultancy.mjs
 *
 * مكتب محاماة is literally "advocacy office" and names a licence category, so
 * it carries the same claim the English "law firm" did. Where the firm uses it
 * of itself it becomes مكتب استشارات قانونية.
 *
 * WHY A PLAIN REPLACEMENT IS SAFE HERE, WHERE IT WAS NOT IN ENGLISH
 * English needed rules because 92 of its 320 occurrences were the ordinary
 * noun — "how law firms charge", "a law firm and an accounting firm". Arabic
 * has no such cases: every occurrence is singular مكتب محاماة and every one
 * refers to this firm. The plural مكاتب محاماة, which is how the generic sense
 * would appear, does not occur at all, and neither does شركة محاماة. Checked
 * before writing this, not assumed.
 *
 * The Arabic articles were never translated, which is why the generic uses
 * that dominate the English side have no counterpart.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const PROD = process.env.TARGET === 'production';
const BASE = PROD ? 'https://cms.fakhernco.com' : 'http://localhost:1337';

let token = '';
if (PROD) token = (await readFile(path.join(import.meta.dirname, '..', '.seed-token'), 'utf8')).trim();

const FROM = /مكتب\s+محاما[ةه]/g;
const TO = 'مكتب استشارات قانونية';

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
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

let changes = 0;
function walk(value) {
  if (typeof value === 'string') {
    FROM.lastIndex = 0;
    const n = (value.match(FROM) ?? []).length;
    if (!n) return value;
    changes += n;
    FROM.lastIndex = 0;
    return value.replace(FROM, TO);
  }
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out = {};
    if (value.__component) out.__component = value.__component;
    for (const [k, v] of Object.entries(value)) {
      if (k === '__component') continue;
      if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale', 'localizations'].includes(k)) continue;
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}

console.log(`\n${DRY ? 'DRY RUN — ' : ''}target: ${BASE}`);
console.log(`  مكتب محاماة  ->  ${TO}\n`);

for (const type of TYPES) {
  let rows;
  try {
    rows = (await api('GET', `${type}?${populate()}&locale=ar`)).data ?? [];
  } catch { continue; }

  for (const row of rows) {
    const before = changes;
    const data = walk({ ...row });
    if (changes === before) continue;
    console.log(`  ${type}/ar  ${row.slug}  (${changes - before})`);
    if (!DRY) await api('PUT', `${type}/${row.documentId}?locale=ar&status=published`, { data });
  }
}

console.log(`\n${DRY ? 'would change' : 'changed'} ${changes} occurrence(s)\n`);
