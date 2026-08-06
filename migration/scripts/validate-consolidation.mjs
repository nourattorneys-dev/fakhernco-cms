#!/usr/bin/env node
/**
 * Validate the consolidation map before anything is built on top of it.
 *
 * On the previous migration, 526 of 531 mapped redirects were analysed,
 * scored, written to a CSV — and never shipped, while a 300-rule file sat in
 * Netlify syntax inside a Vercel project doing nothing. Producing a map and
 * shipping a correct one are separate jobs with separate proof. This is the
 * proof for the first one.
 *
 * Checks:
 *   1. every redirect target exists in the map and survives
 *   2. no redirect chains (A -> B where B also redirects)
 *   3. no self-loops
 *   4. no page from the live sitemap is silently missing from the map
 *   5. every URL is accounted for by exactly one action
 *   6. (--live) every redirect target currently returns 200
 *
 *   node migration/scripts/validate-consolidation.mjs [--live]
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "out");
const RAW = join(ROOT, "data", "raw");
const SITE = "https://fakhernco.com";
const LIVE = process.argv.includes("--live");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Minimal CSV reader — handles the quoted fields this file actually uses. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const problems = [];
const fail = (check, detail) => problems.push({ check, detail });

async function main() {
  const map = parseCsv(await readFile(join(OUT, "consolidation-map.csv"), "utf8"));
  const pages = JSON.parse(await readFile(join(RAW, "pages.json"), "utf8"));

  const byPath = new Map(map.map((r) => [r.path, r]));
  const survives = new Set(
    map.filter((r) => r.action === "keep" || r.action === "convert").map((r) => r.path),
  );
  const redirects = map.filter((r) => r.action === "redirect");

  // 1 + 3. Targets must exist and survive; nothing points at itself.
  for (const r of redirects) {
    if (!r.redirect_to) { fail("missing-target", `/${r.slug}/ is action=redirect with an empty redirect_to`); continue; }
    if (r.redirect_to === r.path) fail("self-loop", `/${r.slug}/ redirects to itself`);
    if (!byPath.has(r.redirect_to)) {
      fail("unknown-target", `/${r.slug}/ -> ${r.redirect_to} (target is not a page in the map)`);
    } else if (!survives.has(r.redirect_to)) {
      const t = byPath.get(r.redirect_to);
      fail("dead-target", `/${r.slug}/ -> ${r.redirect_to} but that target is action=${t.action}`);
    }
  }

  // 2. Chains: a target that is itself a redirect source.
  const redirectSources = new Set(redirects.map((r) => r.path));
  for (const r of redirects) {
    if (redirectSources.has(r.redirect_to)) {
      fail("chain", `/${r.slug}/ -> ${r.redirect_to} -> ${byPath.get(r.redirect_to).redirect_to}`);
    }
  }

  // 4. Nothing from the live site may be missing.
  for (const p of pages) {
    const path = new URL(p.link).pathname;
    if (!byPath.has(path)) fail("dropped", `${path} exists on the live site but is absent from the map`);
  }

  // 5. Exactly one action each, and it must be a known one.
  const valid = new Set(["keep", "convert", "redirect", "review", "delete"]);
  const seen = new Set();
  for (const r of map) {
    if (!valid.has(r.action)) fail("bad-action", `/${r.slug}/ has action="${r.action}"`);
    if (seen.has(r.path)) fail("duplicate-row", `${r.path} appears more than once`);
    seen.add(r.path);
  }

  // 6. Optional live check — targets must actually be reachable today.
  if (LIVE) {
    const targets = [...new Set(redirects.map((r) => r.redirect_to))];
    for (const t of targets) {
      try {
        const res = await fetch(SITE + t, { headers: { "User-Agent": UA }, redirect: "manual" });
        if (res.status !== 200) fail("target-not-200", `${t} returns HTTP ${res.status} on the live site`);
      } catch (err) {
        fail("target-unreachable", `${t} — ${err.message}`);
      }
    }
  }

  // ---- Report ----
  const counts = map.reduce((a, r) => ({ ...a, [r.action]: (a[r.action] ?? 0) + 1 }), {});
  console.log(`map rows            ${map.length}`);
  console.log(`live pages          ${pages.length}`);
  console.log(`survive             ${survives.size}`);
  console.log(`redirects           ${redirects.length}`);
  console.log(`unique targets      ${new Set(redirects.map((r) => r.redirect_to)).size}`);
  console.log(`live target check   ${LIVE ? "on" : "off (pass --live to enable)"}\n`);

  if (!problems.length) {
    console.log("PASS — no chains, no self-loops, no dead targets, no dropped pages.");
    return;
  }
  console.log(`FAIL — ${problems.length} problem(s):\n`);
  const grouped = problems.reduce((a, p) => ({ ...a, [p.check]: [...(a[p.check] ?? []), p.detail] }), {});
  for (const [check, details] of Object.entries(grouped)) {
    console.log(`  ${check} (${details.length})`);
    for (const d of details) console.log(`    - ${d}`);
  }
  process.exitCode = 1;
}

main().catch((e) => { console.error("validate failed:", e); process.exit(1); });
