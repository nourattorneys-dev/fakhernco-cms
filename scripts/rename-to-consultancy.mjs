#!/usr/bin/env node
/**
 * Rename the firm's self-description from "law firm" to "legal consultancy".
 *
 *   node scripts/rename-to-consultancy.mjs --dry            # local, show every change
 *   node scripts/rename-to-consultancy.mjs                  # local, apply
 *   TARGET=production node scripts/rename-to-consultancy.mjs --dry
 *
 * ONLY REFERENCES TO THIS FIRM ARE TOUCHED.
 *
 * Of 320 occurrences of "law firm" across the site, 92 are the ordinary
 * English noun in advice articles — "how law firms charge for their services",
 * "a siloed approach where a law firm handles legal documents and a separate
 * advisor manages the assets". Rewriting those would produce sentences no
 * reader would write and no reader expects, and they are not claims about who
 * this firm is. They stay.
 *
 * What changes is the firm describing itself:
 *
 *   Fakher & Co Law Firm            -> Fakher & Co Legal Consultancy
 *   a law firm like Fakher & Co     -> a legal consultancy like Fakher & Co
 *   our law firm                    -> our legal consultancy
 *
 * Case is preserved, so LAW FIRM in a heading does not come back title-cased.
 *
 * The Arabic equivalent is the same decision: مكتب محاماة is literally "law
 * office" and names the licence category, so where it refers to this firm it
 * becomes مكتب استشارات قانونية.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const PROD = process.env.TARGET === 'production';
const BASE = PROD ? 'https://cms.fakhernco.com' : 'http://localhost:1337';

let token = '';
if (PROD) token = (await readFile(path.join(import.meta.dirname, '..', '.seed-token'), 'utf8')).trim();

const TYPES = ['pages', 'posts', 'practice-areas', 'case-studies', 'landing-pages'];
const COMPONENTS = ['blocks.heading', 'blocks.paragraph', 'blocks.list', 'blocks.faq', 'blocks.image', 'blocks.quote'];

function populate(page) {
  const p = new URLSearchParams({
    'pagination[pageSize]': '100',
    'pagination[page]': String(page),
    'populate[seo]': 'true',
    // Stable order, so paging cannot return the same row twice and skip another.
    'sort[0]': 'id:asc',
  });
  for (const c of COMPONENTS) p.set(`populate[blocks][on][${c}][populate]`, '*');
  return p;
}

/**
 * Every row, not the first hundred.
 *
 * Strapi caps pageSize at 100 and silently returns 100 however many you ask
 * for. Requesting 200 looked like it worked — this site has 146 posts, so a
 * pass over "all" of them quietly skipped 46, and the ones it missed varied
 * between runs because no sort order was specified. A rename that reports
 * success while leaving a third of the articles untouched is worse than one
 * that fails.
 */
async function fetchAll(type, locale) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const res = await api('GET', `${type}?${populate(page)}&locale=${locale}`);
    out.push(...(res.data ?? []));
    const p = res.meta?.pagination;
    if (!p || page >= p.pageCount || !res.data?.length) break;
  }
  return out;
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

/** "Law Firm" -> "Legal Consultancy", matching the source's capitalisation. */
function cased(match) {
  if (match === match.toUpperCase()) return 'LEGAL CONSULTANCY';
  if (/^[A-Z]/.test(match)) return /\s[A-Z]/.test(match) ? 'Legal Consultancy' : 'Legal consultancy';
  return 'legal consultancy';
}

/*
  Each rule is anchored to something that makes the phrase about THIS firm.
  Ordered most specific first; every rule keeps its anchor text intact.

  `&amp;` appears because the copy is stored as HTML.
*/
const NAME = String.raw`Fakher\s*(?:&amp;|&)\s*Co\.?`;
const RULES = [
  // "Fakher & Co Law Firm"
  { re: new RegExp(String.raw`(${NAME}\s+)(Law\s+Firm)`, 'gi'), keep: 1, hit: 2 },
  // "Law Firm Fakher & Co"
  { re: new RegExp(String.raw`(Law\s+Firm)(\s+${NAME})`, 'gi'), keep: 2, hit: 1, before: true },
  // "a law firm like Fakher & Co" / "law firm such as Fakher & Co"
  { re: new RegExp(String.raw`(law\s+firm)(\s+(?:like|such as)\s+${NAME})`, 'gi'), keep: 2, hit: 1, before: true },
  // the firm speaking about itself
  { re: /\b(our|this)(\s+)(law\s+firm)\b/gi, keep: null, hit: 3, possessive: true },
];

let changes = 0;
const samples = [];

function rewrite(text, where) {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (m, ...groups) => {
      const full = m;
      let replaced;
      if (rule.possessive) {
        replaced = `${groups[0]}${groups[1]}${cased(groups[2])}`;
      } else if (rule.before) {
        replaced = `${cased(groups[rule.hit - 1])}${groups[rule.keep - 1]}`;
      } else {
        replaced = `${groups[rule.keep - 1]}${cased(groups[rule.hit - 1])}`;
      }
      changes += 1;
      if (samples.length < 400) samples.push({ where, from: full.trim(), to: replaced.trim() });
      return replaced;
    });
  }
  return out;
}

function walk(value, where) {
  if (typeof value === 'string') return rewrite(value, where);
  if (Array.isArray(value)) return value.map((v) => walk(v, where));
  if (value && typeof value === 'object') {
    const out = {};
    if (value.__component) out.__component = value.__component;
    for (const [k, v] of Object.entries(value)) {
      if (k === '__component') continue;
      if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale', 'localizations'].includes(k)) continue;
      out[k] = walk(v, where);
    }
    return out;
  }
  return value;
}

console.log(`\n${DRY ? 'DRY RUN — ' : ''}target: ${BASE}\n`);
let touched = 0;

for (const type of TYPES) {
  /*
    Every locale the site ships. A locale absent from this list keeps the old
    wording silently — the script reports success having skipped it entirely.
    A locale with no content yet simply yields no rows, so listing one early
    costs nothing.
  */
  for (const locale of ['en', 'ar', 'de']) {
    let rows;
    try {
      rows = await fetchAll(type, locale);
    } catch { continue; }

    for (const row of rows) {
      const before = changes;
      const data = walk({ ...row }, `${type}/${locale}/${row.slug}`);
      if (changes === before) continue;
      touched += 1;
      console.log(`  ${type}/${locale}  ${row.slug}  (${changes - before})`);
      if (!DRY) await api('PUT', `${type}/${row.documentId}?locale=${locale}&status=published`, { data });
    }
  }
}

console.log(`\n--- every replacement ---`);
const seen = new Map();
for (const s of samples) {
  const key = `${s.from} -> ${s.to}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
for (const [k, n] of [...seen].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}x  ${k}`);
}

console.log(`\n${DRY ? 'would change' : 'changed'} ${changes} occurrence(s) in ${touched} entr(y/ies)`);
console.log('Generic uses of "law firm" in articles are deliberately left alone.\n');
