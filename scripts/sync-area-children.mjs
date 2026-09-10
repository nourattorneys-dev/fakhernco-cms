/**
 * Mirror each practice area's `pages` relation from English into the other
 * locales.
 *
 *   node scripts/sync-area-children.mjs          # dry: print the plan
 *   node scripts/sync-area-children.mjs --live   # write
 *
 * WHY THIS EXISTS
 * The header's Services menu lists each practice area with its child pages —
 * and the children come from the area→pages RELATION, which in Strapi is
 * per-locale. Every seeding and translation pass here copied title/seo/blocks
 * and never the relation, so the English menu had 44 child links while the
 * Arabic and German menus had zero. Arabic shipped that way originally; the
 * German translation faithfully reproduced the gap.
 *
 * The English tree is the source of truth. For each area, each locale gets the
 * SAME children by slug — but only the ones that exist in that locale, because
 * a menu must not link to a page that is not there (the same promise href()
 * makes everywhere else).
 *
 * Idempotent: the relation is set wholesale each run, so re-running converges.
 * Run it again after translating pages into a locale — a child that gained a
 * translation joins its area's menu on the next pass.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = process.env.STRAPI_URL?.trim() || 'https://cms.fakhernco.com';
const LIVE = process.argv.includes('--live');
const LOCALES = ['ar', 'de'];

function token() {
  if (process.env.STRAPI_TOKEN?.trim()) return process.env.STRAPI_TOKEN.trim();
  try {
    return readFileSync(path.join(ROOT, '.seed-token'), 'utf8').trim();
  } catch {
    console.error('No STRAPI_TOKEN and no .seed-token file.');
    process.exit(1);
  }
}
const TOKEN = token();

async function api(method, pathname, body) {
  const res = await fetch(`${TARGET}/api/${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const enAreas = (
  await api(
    'GET',
    'practice-areas?locale=en&fields[0]=slug&populate[pages][fields][0]=slug&sort[0]=order:asc&pagination[pageSize]=50',
  )
).data;

let failures = 0;

for (const locale of LOCALES) {
  // One lookup for the whole locale: slug -> that locale's page entry id.
  const localePages = new Map();
  for (let page = 1; ; page += 1) {
    const res = await api(
      'GET',
      `pages?locale=${locale}&fields[0]=slug&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    for (const row of res.data) localePages.set(row.slug, row.id);
    if (page >= res.meta.pagination.pageCount) break;
  }

  for (const area of enAreas) {
    const childSlugs = (area.pages ?? []).map((p) => p.slug);
    const present = childSlugs.filter((s) => localePages.has(s));
    const missing = childSlugs.filter((s) => !localePages.has(s));

    // Does this area exist in the locale at all? (Arabic lacks one.)
    const localized = await api(
      'GET',
      `practice-areas?filters[slug][$eq]=${area.slug}&locale=${locale}&fields[0]=slug`,
    );
    if (!localized.data.length) {
      console.log(`  – ${locale} ${area.slug}: area not localised, skipped`);
      continue;
    }

    console.log(
      `  ${LIVE ? '→' : '·'} ${locale} ${area.slug}: ${present.length}/${childSlugs.length} children` +
        `${missing.length ? ` (absent in ${locale}: ${missing.join(', ')})` : ''}${LIVE ? '' : ' (dry)'}`,
    );

    if (!LIVE) continue;
    try {
      await api('PUT', `practice-areas/${area.documentId}?locale=${locale}&status=published`, {
        data: { pages: present.map((s) => localePages.get(s)) },
      });
    } catch (err) {
      console.error(`    ✗ ${err.message}`);
      failures += 1;
    }
  }
}

if (!LIVE) console.log('\nDry run. Re-run with --live to write.');
if (failures) process.exit(1);
