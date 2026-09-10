/**
 * Publish translated localisations onto existing documents, from JSON files.
 *
 *   node scripts/publish-translations.mjs --dry   # default: print, write nothing
 *   node scripts/publish-translations.mjs --live  # actually PUT
 *
 * WHY THIS EXISTS
 * German content arrives in reviewed batches (first ~3 pages, then 7–10). The
 * admin panel is the normal path for day-to-day editing, but a batch prepared
 * as files — translated, diffed, reviewed — wants a repeatable publisher that
 * cannot half-apply: each entry either PUTs completely or reports its failure.
 *
 * THE MANIFEST, not a CLI arg soup: each entry names the collection, the
 * documentId of the ENGLISH document (a localisation attaches to the same
 * document — see remote-seed.mjs), and the file holding the translated fields.
 *
 * TWO RULES THE PAYLOAD MUST FOLLOW
 * - `slug` is set explicitly to the English slug. Slugs are identical across
 *   locales by design — pathIn() in the front end is a pure prefix swap, and
 *   hreflang, the sitemap and the switcher all depend on it. Omit the slug and
 *   Strapi derives one from the translated TITLE ("kontakt"), silently breaking
 *   the invariant.
 * - No `id` keys anywhere. Component ids belong to the source locale's rows;
 *   sending them into another locale's PUT is undefined behaviour at best.
 *
 * Auth: the same .seed-token / STRAPI_TOKEN as remote-seed.mjs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = process.env.STRAPI_URL?.trim() || 'https://cms.fakhernco.com';
const LIVE = process.argv.includes('--live');
const FROM_TMP = process.argv.includes('--from-tmp');

const MANIFEST = {
  locale: 'de',
  entries: [
    // ---- batch 1 (published 2026-08-21) — kept for re-runs; PUT is idempotent
    {
      type: 'pages',
      slug: 'contact-us',
      documentId: 'uluiljif4phktn9b7s1gd52o',
      file: '/tmp/de-contact-us.json',
    },
    {
      type: 'practice-areas',
      slug: 'company-formation-corporate-services',
      documentId: 'w16vmlf1v3igohut0etfqoeu',
      file: '/tmp/de-company-formation-corporate-services.json',
    },
    {
      type: 'practice-areas',
      slug: 'contracts-legal-document-drafting',
      documentId: 'vm9ozpp16sxqftmfkr0eknuu',
      file: '/tmp/de-contracts-legal-document-drafting.json',
    },
    // ---- batch 2: the homepage cluster + remaining practice areas
    {
      type: 'practice-areas',
      slug: 'litigation-dispute-resolution',
      documentId: 'taxx6odwk8jco3qr98cwuvx5',
      file: '/tmp/de-litigation-dispute-resolution.json',
    },
    {
      type: 'practice-areas',
      slug: 'personal-criminal-legal-services',
      documentId: 'z7vjo01yik9vz0ax7ba0xtzu',
      file: '/tmp/de-personal-criminal-legal-services.json',
    },
    {
      type: 'practice-areas',
      slug: 'private-notary-attestation-services',
      documentId: 'b90m0wsr11l0eooa5xebhv5b',
      file: '/tmp/de-private-notary-attestation-services.json',
    },
    {
      type: 'pages',
      slug: 'home',
      documentId: 'dxc8srh83xl51x8tvnfulysg',
      file: '/tmp/de-home.json',
    },
    /*
      Single types: no documentId in the path and no slug to pin — Strapi
      addresses them by name. Media relations (heroImage, sectionImages, logo)
      are numeric ids copied from the English locale; media itself is not
      localised, so the same photographs serve every language.
    */
    { type: 'homepage', singleType: true, file: '/tmp/de-homepage-single.json' },
    { type: 'site-setting', singleType: true, file: '/tmp/de-site-setting.json' },
  ],
};

function token() {
  if (process.env.STRAPI_TOKEN?.trim()) return process.env.STRAPI_TOKEN.trim();
  try {
    return readFileSync(path.join(ROOT, '.seed-token'), 'utf8').trim();
  } catch {
    console.error('No STRAPI_TOKEN and no .seed-token file.');
    process.exit(1);
  }
}

/** Strip every `id` key, recursively. See the header for why. */
function stripIds(value) {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'id')
        .map(([k, v]) => [k, stripIds(v)]),
    );
  }
  return value;
}

const TOKEN = token();

async function put(pathname, body) {
  const res = await fetch(`${TARGET}/api/${pathname}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`PUT ${pathname} -> ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/*
  --from-tmp reads /tmp/de-manifest.json instead of the built-in list — the
  shape the bulk-translation pipeline writes. The built-in manifest stays for
  the reviewed batches 1–2.
*/
const { locale, entries } = FROM_TMP
  ? JSON.parse(readFileSync('/tmp/de-manifest.json', 'utf8'))
  : MANIFEST;
let failures = 0;

for (const entry of entries) {
  let translated;
  try {
    translated = JSON.parse(readFileSync(entry.file, 'utf8'));
  } catch (err) {
    console.error(`  ✗ ${entry.slug}: cannot read ${entry.file} — ${err.message}`);
    failures += 1;
    continue;
  }

  const data = entry.singleType
    ? stripIds(translated)
    : stripIds({
        ...translated,
        slug: entry.slug, // ALWAYS the English slug — see the header.
        // German has no legacy WordPress URLs. landing-pages has no such
        // field at all, and Strapi rejects unknown keys rather than ignoring
        // them.
        ...(entry.type === 'landing-pages' ? {} : { legacyUrl: null }),
      });

  const blocks = Array.isArray(data.blocks) ? data.blocks.length : 0;
  const label = entry.singleType ? entry.type : `${entry.type}/${entry.slug}`;
  console.log(
    `  ${LIVE ? '→' : '·'} ${label} [${locale}] — ` +
      `"${data.title ?? data.siteName ?? data.heroTitle ?? ''}"` +
      `${blocks ? `, ${blocks} blocks` : ''}${LIVE ? '' : ' (dry)'}`,
  );

  if (!LIVE) continue;

  try {
    const pathname = entry.singleType
      ? `${entry.type}?locale=${locale}&status=published`
      : `${entry.type}/${entry.documentId}?locale=${locale}&status=published`;
    await put(pathname, { data });
    console.log(`    published`);
  } catch (err) {
    console.error(`    ✗ ${err.message}`);
    failures += 1;
  }
}

if (!LIVE) {
  console.log('\nDry run. Re-run with --live to publish.');
}
if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
