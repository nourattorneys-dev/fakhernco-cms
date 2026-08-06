#!/usr/bin/env node
/**
 * Turn Bold Page Builder markup into a clean, portable block union.
 *
 * The live site stores content as proprietary `bt_bb_*` markup tied to the
 * Avantage theme. The REST API returns it rendered, which is usable — but the
 * chrome has to come off before anything can go into Strapi.
 *
 * There are two content shapes, and the extractor handles both:
 *
 *   PROSE   (all 140 posts, the 5 pillar pages)
 *           Real semantic HTML inside `div.bt_bb_text` wrappers, plus
 *           `div.bt_bb_accordion_item` pairs that are really FAQs.
 *
 *   LAYOUT  (the ~40 menu children, the federation pages)
 *           Almost no <p>. Text lives in `header.bt_bb_headline` — a heading
 *           span plus a `bt_bb_headline_subheadline` — with separators for
 *           spacing and `bt_bb_button` CTAs.
 *
 * Every run reports text coverage per document: what fraction of the visible
 * text ended up inside a block. Anything that did not is listed in `unhandled`
 * so it cannot be silently lost — a page that extracts to an empty body would
 * otherwise still return 200 and pass every downstream check.
 *
 *   node migration/scripts/extract-content.mjs
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const OUT = join(ROOT, "out");
const CONTENT = join(ROOT, "data", "content");

const INLINE_OK = new Set(["strong", "b", "em", "i", "a", "u", "br", "sup", "sub", "code", "span"]);

const clean = (s) =>
  (s ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Resolve a WordPress derivative filename back to the original upload.
 *   foo-640x224.png       -> foo.png       (generated size)
 *   foo.png.webp          -> foo.png       (Robin Image Optimizer sibling)
 *   foo-scaled.jpg        -> foo-scaled.jpg (kept: -scaled IS the stored file)
 * Without this the migration points at files that were never uploaded to Strapi.
 */
export function originalUpload(url) {
  if (!url) return url;
  let out = url.replace(/\.(jpe?g|png|gif)\.webp$/i, ".$1");
  out = out.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|gif|webp))$/i, "$1");
  return out;
}

const hasClass = (n, c) => (n.getAttribute?.("class") ?? "").split(/\s+/).includes(c);
const classOf = (n) => n.getAttribute?.("class") ?? "";

/** Keep light inline markup, drop everything else, so rich text stays rich. */
function inlineHtml(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += child.rawText; continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.rawTagName?.toLowerCase();
    if (tag === "br") { out += " "; continue; }
    if (INLINE_OK.has(tag) && tag !== "span") {
      const href = tag === "a" ? child.getAttribute("href") : null;
      const open = href ? `<a href="${href}">` : `<${tag}>`;
      out += `${open}${inlineHtml(child)}</${tag}>`;
    } else {
      out += inlineHtml(child);
    }
  }
  return clean(out).replace(/<(\w+)( [^>]*)?>\s*<\/\1>/g, "");
}

/** Parse the standard semantic HTML found inside a bt_bb_text wrapper. */
function blocksFromProse(node, blocks) {
  for (const el of node.childNodes) {
    if (el.nodeType === 3) {
      const t = clean(el.rawText);
      if (t) blocks.push({ type: "paragraph", html: t });
      continue;
    }
    if (el.nodeType !== 1) continue;
    const tag = el.rawTagName?.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const text = clean(el.text);
      if (text) blocks.push({ type: "heading", level: Number(tag[1]), text });
    } else if (tag === "p") {
      const html = inlineHtml(el);
      if (html) blocks.push({ type: "paragraph", html });
    } else if (tag === "ul" || tag === "ol") {
      const items = el.querySelectorAll("li").map((li) => inlineHtml(li)).filter(Boolean);
      if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items });
    } else if (tag === "table") {
      const headers = el.querySelectorAll("th").map((th) => clean(th.text));
      const rows = el.querySelectorAll("tr")
        .map((tr) => tr.querySelectorAll("td").map((td) => inlineHtml(td)))
        .filter((r) => r.length);
      if (rows.length || headers.length) blocks.push({ type: "table", headers, rows });
    } else if (tag === "img") {
      const src = originalUpload(el.getAttribute("src"));
      if (src) blocks.push({ type: "image", src, alt: clean(el.getAttribute("alt")) });
    } else if (tag === "blockquote") {
      const html = inlineHtml(el);
      if (html) blocks.push({ type: "quote", html });
    } else {
      blocksFromProse(el, blocks);
    }
  }
}

/** Walk the builder tree, emitting blocks and never descending into a handled node. */
function extract(html) {
  const root = parse(html);
  const blocks = [];
  const unhandled = [];

  const visit = (node) => {
    if (node.nodeType === 3) {
      const t = clean(node.rawText);
      if (t.length > 1) unhandled.push({ kind: "loose-text", text: t.slice(0, 120) });
      return;
    }
    if (node.nodeType !== 1) return;

    const cls = classOf(node);
    const tag = node.rawTagName?.toLowerCase();

    // Pure spacing / decoration.
    if (hasClass(node, "bt_bb_separator") || hasClass(node, "bt_bb_background_image_holder_wrapper")) return;

    // FAQ accordions.
    if (hasClass(node, "bt_bb_accordion")) {
      const items = node.querySelectorAll(".bt_bb_accordion_item").map((it) => ({
        question: clean(it.querySelector(".bt_bb_accordion_item_title")?.text),
        answer: clean(it.querySelector(".bt_bb_accordion_item_content")?.text),
      })).filter((i) => i.question && i.answer);
      if (items.length) blocks.push({ type: "faq", items });
      return;
    }

    // LAYOUT shape: headline + optional subheadline.
    if (hasClass(node, "bt_bb_headline")) {
      const tagEl = node.querySelector("[class*=bt_bb_headline_tag]");
      const level = tagEl && /^h[1-6]$/.test(tagEl.rawTagName?.toLowerCase() ?? "")
        ? Number(tagEl.rawTagName[1]) : 2;
      const text = clean(node.querySelector(".bt_bb_headline_content")?.text ?? node.text);
      if (text) blocks.push({ type: "heading", level, text });
      const sub = clean(node.querySelector(".bt_bb_headline_subheadline")?.text);
      if (sub && sub !== text) blocks.push({ type: "paragraph", html: sub });
      return;
    }

    // Icon cards — the theme's `service` component. Used for value grids
    // (/our-unwavering-principles/) and the contact tiles (/contact-us/).
    // Left unhandled these fall through as loose text and the grid structure
    // is lost, which is how they were being silently dropped.
    if (hasClass(node, "bt_bb_service")) {
      const title = clean(node.querySelector(".bt_bb_service_content_title")?.text);
      const text = clean(node.querySelector(".bt_bb_service_content_text")?.text);
      const link = node.querySelector("a")?.getAttribute("href") ?? null;
      if (title || text) blocks.push({ type: "card", title, text, ...(link ? { href: link } : {}) });
      return;
    }

    // CTA buttons.
    if (hasClass(node, "bt_bb_button")) {
      const a = node.querySelector("a");
      const text = clean(a?.text);
      const href = a?.getAttribute("href");
      if (text && href) blocks.push({ type: "button", text, href });
      return;
    }

    // Images.
    if (tag === "img") {
      const src = originalUpload(node.getAttribute("src"));
      if (src) blocks.push({ type: "image", src, alt: clean(node.getAttribute("alt")) });
      return;
    }

    // PROSE shape.
    if (hasClass(node, "bt_bb_text")) {
      blocksFromProse(node, blocks);
      return;
    }

    // Semantic content sitting outside any builder wrapper.
    //
    // Guard: wpautop wraps the ENTIRE builder output in a single <p>, so a
    // naive match here swallows the whole document into one paragraph block
    // (and text-coverage still reads 100%, which is why this hid). Only treat
    // a semantic tag as a leaf when it holds no block-level descendants.
    if (/^(h[1-6]|p|ul|ol|table|blockquote)$/.test(tag ?? "") && !hasBlockDescendant(node)) {
      blocksFromProse({ childNodes: [node] }, blocks);
      return;
    }

    for (const child of node.childNodes) visit(child);
  };

  visit(root);

  // The theme renders some headlines twice for responsive variants. Collapse
  // consecutive identical blocks so the same copy is not imported twice.
  const deduped = blocks.filter((b, i) => i === 0 || JSON.stringify(b) !== JSON.stringify(blocks[i - 1]));

  // Cards arrive one per builder column. Collapse each run into a single grid
  // block so the model stores "a grid of six values", not six loose cards.
  const grouped = [];
  for (const b of deduped) {
    const last = grouped[grouped.length - 1];
    if (b.type === "card") {
      const { type, ...item } = b;
      if (last?.type === "cards") last.items.push(item);
      else grouped.push({ type: "cards", items: [item] });
    } else grouped.push(b);
  }
  return { blocks: grouped, unhandled };
}

const BLOCK_LEVEL = /^(section|div|header|footer|article|aside|nav|table|ul|ol|h[1-6])$/;

function hasBlockDescendant(node) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const t = child.rawTagName?.toLowerCase() ?? "";
    if (BLOCK_LEVEL.test(t)) return true;
    if (hasBlockDescendant(child)) return true;
  }
  return false;
}

const textOfBlocks = (blocks) =>
  blocks.map((b) => {
    switch (b.type) {
      case "heading": return b.text;
      case "paragraph": case "quote": return b.html.replace(/<[^>]+>/g, "");
      case "list": return b.items.join(" ").replace(/<[^>]+>/g, "");
      case "table": return [...b.headers, ...b.rows.flat()].join(" ").replace(/<[^>]+>/g, "");
      case "faq": return b.items.map((i) => `${i.question} ${i.answer}`).join(" ");
      case "cards": return b.items.map((i) => `${i.title} ${i.text}`).join(" ");
      case "button": return b.text;
      default: return "";
    }
  }).join(" ");

const visibleText = (html) =>
  clean(parse(html).text);

const decodeEntities = (s) =>
  (s ?? "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—")
    .replace(/&#8216;|&#8217;/g, "’").replace(/&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, " ");

/**
 * Pull the live Yoast metadata into a portable shape.
 *
 * The brand suffix is stripped deliberately. Every stored title currently ends
 * with " - Fakher & Co"; the Next.js layout will apply a title template that
 * appends the brand itself, and leaving both in place yields
 * "Fakher & Co | About Us - Fakher & Co".
 */
function seoFrom(yoast) {
  if (!yoast) return null;
  const title = decodeEntities(yoast.title ?? "")
    .replace(/\s*[-–|]\s*Fakher\s*&\s*Co\.?\s*$/i, "")
    .trim();
  const robots = yoast.robots ?? {};
  return {
    metaTitle: title || null,
    metaDescription: decodeEntities(yoast.description ?? "").trim() || null,
    canonicalUrl: yoast.canonical ?? null,
    noIndex: robots.index === "noindex",
    ogImageUrl: Array.isArray(yoast.og_image) && yoast.og_image[0]?.url
      ? yoast.og_image[0].url : null,
  };
}

/**
 * What fraction of the source's words survived into blocks, counted as a
 * multiset so repeated words must be matched repeatedly.
 *
 * A plain length ratio does NOT work here: capped at 1 it reads 100% even when
 * the extractor collapses an entire page into one paragraph, which is exactly
 * the failure this is meant to catch.
 */
function tokenRecall(source, extracted) {
  const bag = (s) => {
    const m = new Map();
    for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (w) m.set(w, (m.get(w) ?? 0) + 1);
    }
    return m;
  };
  const a = bag(source);
  const b = bag(extracted);
  let total = 0, matched = 0;
  for (const [w, n] of a) {
    total += n;
    matched += Math.min(n, b.get(w) ?? 0);
  }
  return total ? matched / total : 1;
}

async function main() {
  await rm(CONTENT, { recursive: true, force: true });
  await mkdir(join(CONTENT, "pages"), { recursive: true });
  await mkdir(join(CONTENT, "posts"), { recursive: true });

  const pages = JSON.parse(await readFile(join(RAW, "pages.json"), "utf8"));
  const posts = JSON.parse(await readFile(join(RAW, "posts.json"), "utf8"));
  const cats = JSON.parse(await readFile(join(RAW, "categories.json"), "utf8"));
  const catById = new Map(cats.map((c) => [c.id, c.slug]));

  const report = [];

  async function run(items, kind) {
    for (const item of items) {
      const html = item.content?.rendered ?? "";
      const { blocks, unhandled } = extract(html);

      const src = visibleText(html);
      const got = clean(textOfBlocks(blocks));
      const coverage = tokenRecall(src, got);

      const record = {
        slug: item.slug,
        legacyUrl: new URL(item.link).pathname,
        title: decodeEntities(clean(parse(item.title?.rendered ?? "").text)),
        date: item.date,
        modified: item.modified,
        seo: seoFrom(item.yoast_head_json),
        ...(kind === "posts" ? {
          excerpt: clean(parse(item.excerpt?.rendered ?? "").text),
          categories: (item.categories ?? []).map((id) => catById.get(id)).filter(Boolean),
        } : {}),
        blocks,
        unhandled,
      };
      await writeFile(join(CONTENT, kind, `${item.slug}.json`), JSON.stringify(record, null, 2));

      const counts = blocks.reduce((a, b) => ({ ...a, [b.type]: (a[b.type] ?? 0) + 1 }), {});
      const headings = blocks.filter((b) => b.type === "heading");
      report.push({
        kind, slug: item.slug, words: src ? src.split(" ").length : 0,
        blocks: blocks.length, coverage, counts,
        h1: headings.filter((h) => h.level === 1).length,
        unhandled: unhandled.length,
        shape: (counts.paragraph ?? 0) >= 8 ? "prose" : "layout",
      });
    }
  }

  await run(pages, "pages");
  await run(posts, "posts");
  await writeFile(join(OUT, "extraction-report.json"), JSON.stringify(report, null, 2));

  // ---- Report ----
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const avg = (rows, f) => rows.reduce((s, r) => s + f(r), 0) / (rows.length || 1);

  for (const kind of ["pages", "posts"]) {
    const rows = report.filter((r) => r.kind === kind);
    const clean_ = rows.filter((r) => r.coverage >= 0.9);
    const partial = rows.filter((r) => r.coverage >= 0.7 && r.coverage < 0.9);
    const poor = rows.filter((r) => r.coverage < 0.7);
    console.log(`\n=== ${kind.toUpperCase()} (${rows.length}) ===`);
    console.log(`  mean text coverage   ${pct(avg(rows, (r) => r.coverage))}`);
    console.log(`  >=90% captured       ${clean_.length}`);
    console.log(`  70-90%               ${partial.length}`);
    console.log(`  <70%  needs review   ${poor.length}`);
    console.log(`  mean blocks/doc      ${avg(rows, (r) => r.blocks).toFixed(1)}`);
    const shapes = rows.reduce((a, r) => ({ ...a, [r.shape]: (a[r.shape] ?? 0) + 1 }), {});
    console.log(`  shape                ${Object.entries(shapes).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (poor.length) {
      console.log(`  worst:`);
      for (const r of poor.sort((a, b) => a.coverage - b.coverage).slice(0, 10)) {
        console.log(`    ${pct(r.coverage).padStart(6)}  /${r.slug}/  (${r.words}w, ${r.blocks} blocks, ${r.unhandled} unhandled)`);
      }
    }
  }

  const totals = report.reduce((a, r) => {
    for (const [k, v] of Object.entries(r.counts)) a[k] = (a[k] ?? 0) + v;
    return a;
  }, {});
  console.log(`\n=== BLOCK TYPES ACROSS ALL 220 DOCUMENTS ===`);
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(10)} ${String(v).padStart(5)}`);
  }

  const multiH1 = report.filter((r) => r.h1 > 1);
  console.log(`\ndocuments with more than one H1: ${multiH1.length}`);
  if (multiH1.length) {
    console.log(`  e.g. ${multiH1.slice(0, 6).map((r) => `/${r.slug}/ (${r.h1})`).join(", ")}`);
  }
  console.log(`\nwritten: ${CONTENT}/{pages,posts}/*.json`);
  console.log(`         ${join(OUT, "extraction-report.json")}`);
}

main().catch((e) => { console.error("extract-content failed:", e); process.exit(1); });
