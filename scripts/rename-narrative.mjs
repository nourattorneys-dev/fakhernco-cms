#!/usr/bin/env node
/**
 * The second pass of the "law firm" -> "legal consultancy" rename.
 *
 *   node scripts/rename-narrative.mjs --dry
 *   TARGET=production node scripts/rename-narrative.mjs
 *
 * The first pass was mechanical: 227 occurrences sitting directly beside the
 * company name, safely matched by pattern. What is left is narrative — the
 * firm describing itself in prose, with nothing adjacent to anchor a regex to:
 *
 *   "his journey began not with the goal of building a law firm"
 *   "Fakher & Co isn't just a law firm — it's a vision in motion"
 *
 * Those need reading, so they are listed here explicitly. Each entry is an
 * exact string, and anything that does not match is reported rather than
 * silently skipped — a rename that quietly does nothing is worse than one that
 * fails loudly.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * Generic uses stay. "he began his career in established law firms" is about
 * other people's firms. "choosing a law firm is one of the most critical
 * decisions" is ordinary advice. "Nour Attorneys Law Firm" is a partner's
 * actual registered name. Rewriting any of those would be wrong.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const PROD = process.env.TARGET === 'production';
const BASE = PROD ? 'https://cms.fakhernco.com' : 'http://localhost:1337';

let token = '';
if (PROD) token = (await readFile(path.join(import.meta.dirname, '..', '.seed-token'), 'utf8')).trim();

/** [type, slug, from, to] — exact, ordered longest-first within a page. */
const EDITS = [
  ['pages', 'about-us',
    'not with the goal of building a law firm',
    'not with the goal of building a legal consultancy'],
  ['pages', 'about-us',
    'vision to create a truly client-centered law firm',
    'vision to create a truly client-centered legal consultancy'],
  ['pages', 'about-us',
    'isn’t just a law firm',
    'isn’t just a legal consultancy'],
  ['pages', 'about-us',
    "isn't just a law firm",
    "isn't just a legal consultancy"],

  ['pages', 'home', 'A Law Firm Built for You', 'A Legal Consultancy Built for You'],
  ['pages', 'home',
    'A Law Firm Built on Expertise and Client Care',
    'A Legal Consultancy Built on Expertise and Client Care'],
  ['pages', 'home',
    'one of the established law firms in Abu Dhabi',
    'one of the established legal consultancies in Abu Dhabi'],
  // "other law firms" implies this firm is one. It is not, any more.
  ['pages', 'home', 'sets us apart from other law firms in UAE', 'sets us apart from other firms in UAE'],

  ['pages', 'certified-true-copy-services',
    'Certified by a Trusted Law Firm',
    'Certified by a Trusted Legal Consultancy'],
  ['pages', 'construction-disputes',
    'require a law firm that speaks the language',
    'require a legal consultancy that speaks the language'],
  ['pages', 'contact-us',
    'Reaching out to a law firm',
    'Reaching out to a legal consultancy'],
  // No leading "a ": the copy is HTML and a <strong> opens mid-phrase —
  // "offers a <strong>personal, boutique law firm approach</strong>".
  ['pages', 'legal-document-drafting-review',
    'personal, boutique law firm approach',
    'personal, boutique approach'],

  ['practice-areas', 'company-formation-corporate-services',
    'We are a law firm that understands',
    'We are a legal consultancy that understands'],

  ['landing-pages', 'company-formation',
    'Why a law firm rather than a formation agent',
    'Why a legal consultancy rather than a formation agent'],

  /*
    Two articles describe the firm without putting the words next to its name,
    so the mechanical pass could not see them. Found by sweeping every row —
    which only worked once the pagination bug below was fixed.
  */
  ['posts', 'ico-token-issuance-uae-vara',
    'a leading UAE law firm specializing',
    'a leading UAE legal consultancy specializing'],
  ['posts', 'notarization-services-uae',
    'As a leading law firm',
    'As a leading legal consultancy'],
];

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

let hits = 0;
function apply(value, from, to) {
  if (typeof value === 'string') {
    if (!value.includes(from)) return value;
    hits += value.split(from).length - 1;
    return value.split(from).join(to);
  }
  if (Array.isArray(value)) return value.map((v) => apply(v, from, to));
  if (value && typeof value === 'object') {
    const out = {};
    if (value.__component) out.__component = value.__component;
    for (const [k, v] of Object.entries(value)) {
      if (k === '__component') continue;
      if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale', 'localizations'].includes(k)) continue;
      out[k] = apply(v, from, to);
    }
    return out;
  }
  return value;
}

console.log(`\n${DRY ? 'DRY RUN — ' : ''}target: ${BASE}\n`);

// Group by page so each is fetched and written once.
const byPage = new Map();
for (const [type, slug, from, to] of EDITS) {
  const key = `${type}|${slug}`;
  if (!byPage.has(key)) byPage.set(key, []);
  byPage.get(key).push([from, to]);
}

let missed = 0;
for (const [key, edits] of byPage) {
  const [type, slug] = key.split('|');
  const rows = (await api('GET', `${type}?${populate()}&filters[slug][$eq]=${slug}&locale=en`)).data ?? [];
  if (!rows.length) { console.log(`  ! ${type}/${slug} NOT FOUND`); missed += 1; continue; }

  let data = { ...rows[0] };
  const applied = [];
  for (const [from, to] of edits) {
    const before = hits;
    data = apply(data, from, to);
    if (hits > before) applied.push(`${hits - before}x  "${from.slice(0, 46)}…"`);
    else applied.push(`  0x  NOT FOUND: "${from.slice(0, 46)}…"`);
  }

  console.log(`  ${type}/${slug}`);
  for (const line of applied) {
    console.log(`      ${line}`);
    if (line.includes('NOT FOUND')) missed += 1;
  }
  if (!DRY) await api('PUT', `${type}/${rows[0].documentId}?locale=en&status=published`, { data });
}

console.log(`\n${DRY ? 'would change' : 'changed'} ${hits} occurrence(s)`);
if (missed) console.log(`\x1b[33m${missed} phrase(s) did not match — check the wording above.\x1b[0m`);
console.log('');
