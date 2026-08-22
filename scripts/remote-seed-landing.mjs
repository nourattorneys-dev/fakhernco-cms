#!/usr/bin/env node
/**
 * Push the landing pages — both locales — from the local CMS to production.
 *
 *   node scripts/remote-seed-landing.mjs --dry
 *   node scripts/remote-seed-landing.mjs
 *
 * The general remote-seed script predates the Arabic translations and writes
 * landing pages in English only, so this covers the pair.
 *
 * THE ARABIC IS A LOCALE OF THE SAME DOCUMENT
 * Written with PUT /api/landing-pages/<documentId>?locale=ar against the
 * English document rather than POSTed separately. A separate POST produces a
 * second documentId, and Strapi then shows two unrelated entries with the same
 * slug and no way to switch languages between them.
 *
 * HERO IMAGES
 * Not localized in the schema, so they are set once on the English write. The
 * production media IDs differ from local, so the image is resolved from a
 * production page that already uses the same photograph rather than uploading
 * a second copy.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SRC = 'http://localhost:1337';
const DST = 'https://cms.fakhernco.com';
const DRY = process.argv.includes('--dry');

const token = (await readFile(path.join(import.meta.dirname, '..', '.seed-token'), 'utf8')).trim();

const COMPONENTS = ['blocks.heading', 'blocks.paragraph', 'blocks.list', 'blocks.faq', 'blocks.image', 'blocks.quote'];
const POPULATE = new URLSearchParams({
  'populate[heroImage]': 'true',
  'populate[seo]': 'true',
  'sort[0]': 'order:asc',
  'pagination[pageSize]': '100',
});
for (const c of COMPONENTS) POPULATE.set(`populate[blocks][on][${c}][populate]`, '*');

async function get(base, url, auth = false) {
  const res = await fetch(`${base}/api/${url}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function send(method, url, body) {
  const res = await fetch(`${DST}/api/${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * Strip everything the write endpoint rejects.
 *
 * `__component` must be re-inserted FIRST. Strapi matches the dynamic-zone
 * entry by the first key it sees, and a spread that puts it anywhere else
 * fails validation with a message that does not mention key order at all.
 */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    if (value.__component) out.__component = value.__component;
    for (const [k, v] of Object.entries(value)) {
      if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale', 'localizations'].includes(k)) continue;
      if (k === '__component') continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

const localised = (p) => ({
  title: p.title,
  slug: p.slug,
  h1: p.h1,
  subhead: p.subhead ?? null,
  seo: p.seo ? clean(p.seo) : null,
  blocks: (p.blocks ?? []).map(clean),
});

// ---------------------------------------------------------------------- read
/*
  Locales that are translations of the English baseline.

  One list rather than 'ar' spelled out. These nine landing pages are the
  ad-spend surface — the pages the firm actually buys traffic for — so a locale
  missing from here is a language that can never receive a campaign, and nothing
  would have said so.
*/
const TRANSLATED = ['ar', 'de'];

const localEn = (await get(SRC, `landing-pages?${POPULATE}&locale=en`)).data;

/** slug -> page, per translated locale. A locale with none yields an empty map. */
const localBySlug = new Map();
for (const locale of TRANSLATED) {
  const rows = (await get(SRC, `landing-pages?${POPULATE}&locale=${locale}`)).data;
  localBySlug.set(locale, new Map(rows.map((p) => [p.slug, p])));
}

const remoteEn = (await get(DST, `landing-pages?${POPULATE}&locale=en`, true)).data;
const remoteBySlug = new Map(remoteEn.map((p) => [p.slug, p]));

console.log(
  `\nlocal:      ${localEn.length} en, ` +
    TRANSLATED.map((l) => `${localBySlug.get(l).size} ${l}`).join(', '),
);
console.log(`production: ${remoteEn.length} en\n`);

// A production media id for each photograph, keyed by filename, learned from
// the pages that already carry one.
const mediaByName = new Map();
for (const p of remoteEn) {
  const url = p.heroImage?.url;
  if (url) mediaByName.set(url.split('/').pop(), p.heroImage.id);
}

// The same photograph, identified by the local filename's distinctive stem.
function heroFor(localPage) {
  const localUrl = localPage.heroImage?.url ?? '';
  const stem = localUrl.split('/').pop()?.replace(/_[a-f0-9]{10}\./, '.').replace(/\.[a-z]+$/, '') ?? '';
  const key = stem.replace(/[^a-z0-9]/gi, '').slice(0, 28).toLowerCase();
  for (const [name, id] of mediaByName) {
    if (name.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(key)) return id;
  }
  return null;
}

let created = 0, updated = 0, translated = 0;

for (const [i, en] of localEn.entries()) {
  const existing = remoteBySlug.get(en.slug);
  const data = { ...localised(en), order: en.order ?? i };

  if (!existing) {
    const hero = heroFor(en);
    if (hero) data.heroImage = hero;
    console.log(`  + create ${en.slug}${hero ? ` (hero ${hero})` : ' (NO HERO MATCH)'}`);
    if (!DRY) {
      const res = await send('POST', 'landing-pages?locale=en&status=published', { data });
      remoteBySlug.set(en.slug, { ...res.data, slug: en.slug });
    }
    created += 1;
  } else {
    console.log(`  ~ update ${en.slug}`);
    if (!DRY) await send('PUT', `landing-pages/${existing.documentId}?locale=en&status=published`, { data });
    updated += 1;
  }

  for (const locale of TRANSLATED) {
    const row = localBySlug.get(locale).get(en.slug);
    if (!row) {
      console.log(`      ! no ${locale} for ${en.slug}`);
      continue;
    }
    const target = remoteBySlug.get(en.slug);
    if (!DRY && target?.documentId) {
      await send(
        'PUT',
        `landing-pages/${target.documentId}?locale=${locale}&status=published`,
        { data: localised(row) },
      );
    }
    console.log(`      + ${locale}  ${row.h1.slice(0, 44)}`);
    translated += 1;
  }
}

console.log(
  `\n${DRY ? '--dry (nothing written): would create' : 'created'} ${created}, ` +
  `${DRY ? 'update' : 'updated'} ${updated}, arabic ${translated}/${localEn.length}\n`,
);
