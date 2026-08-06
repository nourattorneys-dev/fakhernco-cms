#!/usr/bin/env node
/**
 * Compile the consolidation map into a redirect rule set the front end ships.
 *
 *   npm run wp:redirects
 *
 * Writes migration/out/redirects.json. Copy that into
 * fakhernco-web/src/lib/redirects.json — the Next.js middleware loads it.
 *
 * WHY THIS IS A SEPARATE STEP
 * ---------------------------
 * On the previous migration 526 of 531 mapped redirects were analysed, scored
 * and written to a CSV that was never compiled into anything that runs, while
 * a 300-rule file sat in Netlify syntax inside a Vercel project doing nothing.
 * "Produce the mapping" and "deploy the mapping" are two jobs. This is the
 * bridge between them, and validate-consolidation.mjs proves the input.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MIGRATION = path.join(import.meta.dirname, '..');
const OUT = path.join(MIGRATION, 'out');

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Next.js matches without the trailing slash. */
const norm = (p) => (p.length > 1 ? p.replace(/\/$/, '') : p);

async function main() {
  const map = parseCsv(await readFile(path.join(OUT, 'consolidation-map.csv'), 'utf8'));
  const infra = JSON.parse(await readFile(path.join(OUT, 'infra-redirects.json'), 'utf8'));

  const rules = [];

  for (const row of map) {
    if (row.action === 'redirect') {
      rules.push({
        source: norm(row.path),
        destination: norm(row.redirect_to),
        status: 301,
        reason: row.reason,
      });
    }
    if (row.action === 'delete') {
      // 410 Gone, not 404 and definitely not a redirect to the homepage —
      // Google treats mass redirects of dead URLs to / as soft 404s.
      rules.push({ source: norm(row.path), destination: null, status: 410, reason: row.reason });
    }
  }

  for (const i of infra) {
    rules.push({ source: norm(i.from), destination: i.to, status: 301, reason: i.note });
  }

  // Guard: a source that is also a destination would create a chain.
  const destinations = new Set(rules.map((r) => r.destination).filter(Boolean));
  const chains = rules.filter((r) => destinations.has(r.source));
  if (chains.length) {
    console.error('Redirect chains detected — refusing to write:');
    for (const c of chains) console.error(`  ${c.source} -> ${c.destination}`);
    process.exit(1);
  }

  await writeFile(path.join(OUT, 'redirects.json'), JSON.stringify(rules, null, 2) + '\n');

  console.log(`rules written: ${rules.length}`);
  console.log(`  301: ${rules.filter((r) => r.status === 301).length}`);
  console.log(`  410: ${rules.filter((r) => r.status === 410).length}`);
  console.log(`  no chains, no self-loops`);
  console.log(`\n${path.join(OUT, 'redirects.json')}`);
  console.log('Copy to fakhernco-web/src/lib/redirects.json');
}

main().catch((e) => { console.error('build-redirects failed:', e); process.exit(1); });
