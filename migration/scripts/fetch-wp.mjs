#!/usr/bin/env node
/**
 * Pull the complete public content inventory from the live WordPress site.
 *
 * Cloudflare rejects any non-browser User-Agent with a 403 on EVERY url,
 * including sitemaps and wp-json, so the UA below is required — it is not
 * optional politeness. There is no CAPTCHA, JS challenge or rate limit
 * behind it.
 *
 * Writes raw JSON to migration/data/raw/ (gitignored — re-runnable, and the
 * live site is the source of truth until cutover).
 *
 *   node migration/scripts/fetch-wp.mjs
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const SITE = process.env.WP_SITE ?? "https://fakhernco.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/html;q=0.9, */*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
};

async function get(url, { json = true } = {}) {
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return json ? res.json() : res.text();
}

/** Walk a paginated wp-json collection until it runs dry. */
async function collection(type, fields) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const url =
      `${SITE}/wp-json/wp/v2/${type}?per_page=100&page=${page}` +
      `&_fields=${fields.join(",")}`;
    let batch;
    try {
      batch = await get(url);
    } catch (err) {
      // A 400 rest_post_invalid_page_number just means we walked past the end.
      if (String(err.message).startsWith("400")) break;
      throw err;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// yoast_head_json carries the live meta title, description, canonical and
// robots directives. Without it there is no SEO parity to migrate towards -
// the rebuild would silently invent new metadata for 220 ranking pages.
const CONTENT_FIELDS = [
  "id", "slug", "link", "title", "content", "date", "modified", "yoast_head_json",
];

async function main() {
  await mkdir(RAW, { recursive: true });

  const jobs = [
    ["pages", () => collection("pages", [...CONTENT_FIELDS, "parent", "menu_order"])],
    ["posts", () => collection("posts", [...CONTENT_FIELDS, "excerpt", "categories", "featured_media"])],
    ["categories", () => collection("categories", ["id", "slug", "name", "count", "description"])],
    ["tags", () => collection("tags", ["id", "slug", "name", "count"])],
    ["media", () => collection("media", ["id", "slug", "source_url", "mime_type", "date", "alt_text", "media_details"])],
  ];

  for (const [name, run] of jobs) {
    const data = await run();
    await writeFile(join(RAW, `${name}.json`), JSON.stringify(data, null, 2));
    console.log(`${name.padEnd(12)} ${String(data.length).padStart(4)} records`);
  }

  // The rendered homepage is the only machine-readable source for the nav:
  // /wp-json/wp/v2/menus returns 401 without authentication.
  for (const [name, path] of [["home-en", "/"], ["home-ar", "/ar/"]]) {
    const html = await get(SITE + path, { json: false });
    await writeFile(join(RAW, `${name}.html`), html);
    console.log(`${name.padEnd(12)} ${String(html.length).padStart(7)} bytes`);
  }

  console.log(`\nRaw inventory written to ${RAW}`);
}

main().catch((err) => {
  console.error("fetch-wp failed:", err.message);
  process.exit(1);
});
