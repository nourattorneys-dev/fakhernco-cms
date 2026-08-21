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

const MANIFEST = {
  locale: 'de',
  entries: [
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

const { locale, entries } = MANIFEST;
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

  const data = stripIds({
    ...translated,
    slug: entry.slug, // ALWAYS the English slug — see the header.
    legacyUrl: null, // German has no legacy WordPress URLs.
  });

  const blocks = Array.isArray(data.blocks) ? data.blocks.length : 0;
  console.log(
    `  ${LIVE ? '→' : '·'} ${entry.type}/${entry.slug} [${locale}] — ` +
      `"${data.title}", ${blocks} blocks${LIVE ? '' : ' (dry)'}`,
  );

  if (!LIVE) continue;

  try {
    await put(
      `${entry.type}/${entry.documentId}?locale=${locale}&status=published`,
      { data },
    );
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
