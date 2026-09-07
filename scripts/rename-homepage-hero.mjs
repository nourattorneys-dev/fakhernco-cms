#!/usr/bin/env node
/**
 * The homepage hero eyebrow — the half of the "law firm" rename that was missed.
 *
 *   node scripts/rename-homepage-hero.mjs --dry
 *   TARGET=production node scripts/rename-homepage-hero.mjs --dry
 *   TARGET=production node scripts/rename-homepage-hero.mjs
 *
 * WHY A SEPARATE SCRIPT
 * rename-to-consultancy.mjs and rename-arabic-consultancy.mjs walk
 *   TYPES = ['pages','posts','practice-areas','case-studies','landing-pages']
 * and `homepage` is a single type, so it is in none of them. The rename ran,
 * reported success, and left "Trusted Law Firm in Abu Dhabi & Dubai" sitting in
 * the hero of the most-viewed page on the site — the one place a visitor is
 * guaranteed to read it. The same blind spot bit the language switcher: a
 * homepage that is a single type keeps falling out of collection loops.
 *
 * The eyebrow also never matched the English script's rules, which look for the
 * firm naming itself ("Fakher & Co Law Firm", "our law firm"). "Trusted Law Firm
 * in Abu Dhabi & Dubai" is the firm describing itself without naming itself, so
 * even a homepage-aware run of that script would have skipped it.
 *
 * Arabic does not follow the body copy here. The rest of the Arabic site says
 * مكتب استشارات قانونية ("legal consultancy office") after the earlier rename;
 * the hero is set to خدمات قانونية ("legal services") on explicit instruction.
 * Both drop محاماة, which is the licence-category word that had to go.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const PROD = process.env.TARGET === 'production';
const BASE = PROD ? 'https://cms.fakhernco.com' : 'http://localhost:1337';

let token = '';
if (PROD) token = (await readFile(path.join(import.meta.dirname, '..', '.seed-token'), 'utf8')).trim();
const headers = {
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

/** Locale -> the eyebrow it should carry. */
const HERO = {
  en: 'Trusted Legal Consultancy in Abu Dhabi & Dubai',
  ar: 'خدمات قانونية موثوقة في أبوظبي ودبي',
  de: 'Vertrauenswürdige Rechtsberatung in Abu Dhabi & Dubai',
};

/** Nothing on the site should still call this firm a law firm/office/chambers. */
const BANNED = /law\s*firm|محاماة|Kanzlei/i;

const read = async (locale) => {
  const res = await fetch(`${BASE}/api/homepage?locale=${locale}`, { headers });
  if (!res.ok) throw new Error(`GET homepage?locale=${locale} -> ${res.status}`);
  return (await res.json())?.data?.heroEyebrow ?? '';
};

let changed = 0;
let needsPublish = 0;

for (const [locale, want] of Object.entries(HERO)) {
  const before = await read(locale);
  if (before === want) {
    console.log(`  ${locale}: already correct`);
    continue;
  }
  console.log(`  ${locale}: ${JSON.stringify(before)}\n      -> ${JSON.stringify(want)}`);
  if (DRY) { changed += 1; continue; }

  const res = await fetch(`${BASE}/api/homepage?locale=${locale}`, {
    method: 'PUT', headers, body: JSON.stringify({ data: { heroEyebrow: want } }),
  });
  if (!res.ok) throw new Error(`PUT homepage?locale=${locale} -> ${res.status} ${await res.text()}`);
  changed += 1;

  /*
    Draft & publish is on for this model, so a REST write lands on the draft and
    the published article the website reads can be untouched. Reading it back is
    the only way to know which happened — a 200 on the PUT does not tell you.
  */
  const after = await read(locale);
  if (after !== want) {
    needsPublish += 1;
    console.log(`      WROTE THE DRAFT ONLY — published article still ${JSON.stringify(after)}`);
  }
}

if (BANNED.test(Object.values(HERO).join(' '))) {
  console.error('a replacement still contains a licence-category word');
  process.exit(1);
}

console.log(`\n${DRY ? 'would change' : 'changed'}: ${changed}`);
if (needsPublish) {
  console.log(`NEEDS PUBLISH: ${needsPublish} locale(s) — open the CMS admin and publish the homepage.`);
  process.exit(1);
}
if (!DRY && changed) console.log('HOMEPAGE_HERO_OK');
