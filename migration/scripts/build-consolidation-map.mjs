#!/usr/bin/env node
/**
 * Build the consolidation + redirect decision table for the WordPress migration.
 *
 * WHY NOT PLAIN SIMILARITY CLUSTERING
 * -----------------------------------
 * The first pass clustered pages by TF-IDF cosine and found almost nothing,
 * because these pages are short and share a heavy boilerplate vocabulary.
 * Measured against known duplicate pairs, cosine was actively misleading:
 *
 *   private-notary-services ~ private-notary-attestation-services   cos 0.275, title 0.750
 *   litigation              ~ litigation-dispute-resolution         cos 0.238, title 0.333
 *   lawyer-attestation      ~ lawyer-attestation-2                  cos 0.545, title 0.333
 *
 * The real structure of the site is three tiers, and duplication is almost
 * always "an old v1 page superseded by a newer one":
 *
 *   pillars   5 pages, ~2,300-2,500 words, linked from the mega-menu
 *   children ~40 pages,  ~500-700 words, linked from the mega-menu
 *   orphans  ~20 pages,  ~570-620 words, linked from NOTHING
 *
 * So the algorithm is: classify by navigation reachability, then match each
 * orphan to its best live destination using title overlap as the primary
 * signal and body similarity as corroboration. Every proposal carries a
 * confidence and the method that produced it, so High can ship and Medium
 * gets human review — the schema that worked on the nourattorneys migration.
 *
 *   node migration/scripts/build-consolidation-map.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const OUT = join(ROOT, "out");
const SITE = "https://fakhernco.com";

/**
 * The five service pillars, read off the rendered mega-menu group headers.
 * Hardcoded deliberately: this is an information-architecture decision, not
 * something to infer from word count (legal-document-drafting-review is
 * 1,748 words but is a child, not a pillar).
 */
const PILLARS = [
  "litigation-dispute-resolution",
  "personal-criminal-legal-services",
  "contracts-legal-document-drafting",
  "company-formation-corporate-services",
  "private-notary-attestation-services",
];

/** Pages that exist to serve the theme, not readers. */
const TEMPLATE_SLUGS = new Set(["footer"]);

/**
 * Explicit decisions, taken after reading all 20 orphan bodies.
 *
 * Fuzzy matching alone proposed redirecting every orphan onto a service page,
 * which would have discarded ~5,600 words of genuinely useful content. Reading
 * them shows four distinct families, and only one of them should 301:
 *
 *   1. Superseded v1 service pages — all open with the same "OUR FOCUS" block
 *      and carry an identical h2=6/h3=2 skeleton. A newer page already owns
 *      the topic and sits in the mega-menu. These redirect.
 *   2. Editorial guides misfiled as Pages — real top-of-funnel articles,
 *      currently orphaned and therefore invisible. Convert to Insights and
 *      KEEP THE URL: nothing to redirect, and the blog gains six pieces.
 *   3. Anonymised case studies — a content type the site does not model yet.
 *      Valuable proof for a law firm. Convert and keep the URL.
 *   4. SKP Business Federation section — three pages supporting the federation
 *      page that IS in the nav (linked from its logo). Keep, and link properly.
 *
 * `method: "explicit_override"` marks every row decided here rather than scored.
 */
const DECISIONS = {
  // 1. Superseded v1 service pages -> the live page that replaced them.
  "litigation": { action: "redirect", to: "/litigation-dispute-resolution/", why: "v1 service page ('OUR FOCUS' template) superseded by the litigation pillar." },
  "criminal-cases-representation": { action: "redirect", to: "/criminal-cases/", why: "v1 service page superseded by the nav-linked /criminal-cases/." },
  "drafting-and-reviewing-contracts": { action: "redirect", to: "/contracts-legal-document-drafting/", why: "v1 service page superseded by the contracts pillar." },
  "private-notary-services": { action: "redirect", to: "/private-notary-attestation-services/", why: "v1 service page superseded by the notary pillar." },
  "wills_for_non_muslims": { action: "redirect", to: "/wills-and-estate-planning/", why: "v1 service page superseded. Note: the only slug on the site using underscores." },
  "true-copies-for-documents": { action: "redirect", to: "/certified-true-copy-services/", why: "v1 service page superseded by the nav-linked equivalent." },
  "lawyer-attestation-2": { action: "redirect", to: "/lawyer-attestation/", why: "WordPress slug collision — the '-2' suffix means the base slug was already taken." },

  // 2. Editorial guides -> Insights articles, URL preserved.
  "litigation-vs-arbitration": { action: "convert", to: "insight", why: "Editorial guide ('Courtroom or Conference Room?'), not a service page. 871 words of real top-of-funnel content." },
  "understanding-legal-costs": { action: "convert", to: "insight", why: "Editorial guide on fee transparency — strong trust content for a law firm." },
  "choosing-a-company-structure": { action: "convert", to: "insight", why: "Editorial guide comparing mainland / free zone / offshore." },
  "navigating-employment-law": { action: "convert", to: "insight", why: "Editorial guide aimed at employers." },
  "importance-of-shareholder-agreement": { action: "convert", to: "insight", why: "Editorial guide on shareholder agreements." },
  "real-estate-law-buyers-guide": { action: "convert", to: "insight", why: "Editorial guide to buying UAE property." },

  // 3. Case studies -> a content type the site does not have yet.
  "case-study-family-business": { action: "convert", to: "case-study", why: "Anonymised case study. Needs a Case Study content type — proof content a law firm should surface, not bury." },
  "case-study-foreign-judgment": { action: "convert", to: "case-study", why: "Anonymised case study on cross-border judgment enforcement." },

  // 4. Federation section -> keep, and link it into the IA.
  "our-federation-partners": { action: "keep", to: "", why: "Supports /skp-business-federation/ (nav-linked via its logo). Longest orphan at 1,139 words. Link it from the federation page." },
  "the-integrated-service-model": { action: "keep", to: "", why: "Federation section page. Link from /skp-business-federation/." },
  "the-client-advantage": { action: "keep", to: "", why: "Federation section page. Link from /skp-business-federation/." },

  // Open question for the firm.
  // Kept, not held for review. It is live on WordPress today and 22 blog
  // posts link to it, so leaving it unpublished 404s every one of those
  // links. Publishing restores parity; whether it belongs in the navigation
  // is still the firm's call and does not require the page to be broken in
  // the meantime.
  "legal-consultations": { action: "keep", to: "", why: "v1 service page that nothing replaced. Live today and linked from 22 posts, so it stays published. Open question: does it belong in the menu?" },

  // Two blog archives for one blog.
  "legal-articles": { action: "redirect", to: "/legal-insights/", why: "Second blog archive competing with /legal-insights/. Keep one hub." },
};

const STOP = new Set(
  ("the a an and or of to in for on with by is are be as at from that this it " +
    "your you we our us will can may should must if not no all any more most " +
    "such other than then when where which who whom whose how what why into " +
    "over under also has have had do does did their its his her they them " +
    "services service legal law uae emirates fakher")
    .split(" "),
);

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (text) =>
  text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));

/** Slug words, minus the generic vocabulary — the strongest topical signal. */
const slugTokens = (slug) =>
  slug.replace(/-\d+$/, "").split(/[-_]/).filter((t) => t.length > 2 && !STOP.has(t));

function tfidf(docs) {
  const df = new Map();
  const tfs = docs.map((tokens) => {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const N = docs.length || 1;
  return tfs.map((tf) => {
    const vec = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * Math.log(N / (df.get(t) ?? 1) + 1);
      vec.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  });
}

const cosine = (a, b) => {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [t, w] of s) { const o = l.get(t); if (o) sum += w * o; }
  return sum;
};

const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const t of A) if (B.has(t)) i += 1;
  return i / (A.size + B.size - i);
};

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const pages = JSON.parse(await readFile(join(RAW, "pages.json"), "utf8"));
  const cats = JSON.parse(await readFile(join(RAW, "categories.json"), "utf8"));
  const home = await readFile(join(RAW, "home-en.html"), "utf8");

  const navPaths = new Set(
    [...home.matchAll(/<a\s[^>]*href=["']?(https:\/\/fakhernco\.com\/[^"'\s>#?]*)/g)]
      .map((m) => new URL(m[1]).pathname)
      .filter((p) => !p.startsWith("/ar/")),
  );

  const docs = pages.map((p) => {
    const text = strip(p.content?.rendered ?? "");
    const title = strip(p.title?.rendered ?? "");
    const path = new URL(p.link).pathname;
    return {
      slug: p.slug, path, title, words: text ? text.split(" ").length : 0,
      titleTokens: tokenize(title),
      slugTokens: slugTokens(p.slug),
      bodyTokens: tokenize(text),
      inNav: navPaths.has(path),
      isPillar: PILLARS.includes(p.slug),
      modified: (p.modified ?? "").slice(0, 10),
    };
  });

  const vecs = tfidf(docs.map((d) => d.bodyTokens));
  const vecOf = new Map(docs.map((d, i) => [d.slug, vecs[i]]));
  const bySlug = new Map(docs.map((d) => [d.slug, d]));

  const live = docs.filter((d) => d.inNav && !TEMPLATE_SLUGS.has(d.slug));
  const rows = [];

  /** Best live destination for an orphan, with the evidence that chose it. */
  function bestMatch(src, pool) {
    let best = null;
    for (const dst of pool) {
      if (dst.slug === src.slug) continue;
      const slugJ = jaccard(src.slugTokens, dst.slugTokens);
      const titleJ = jaccard(src.titleTokens, dst.titleTokens);
      const cos = cosine(vecOf.get(src.slug), vecOf.get(dst.slug));
      // Slug overlap dominates: it encodes the topic the URL was ranking for.
      const score = slugJ * 0.55 + titleJ * 0.3 + cos * 0.15;
      if (!best || score > best.score) best = { dst, score, slugJ, titleJ, cos };
    }
    return best;
  }

  for (const d of docs) {
    // 1. Theme template pages never survive.
    if (TEMPLATE_SLUGS.has(d.slug)) {
      rows.push({ ...d, action: "delete", redirect_to: "", confidence: "High",
        method: "template", reason: `Bold Builder template page, indexed with the title "${d.title}". Serve 410.` });
      continue;
    }
    // 2. Decisions taken by reading the page win over any score.
    const call = DECISIONS[d.slug];
    if (call) {
      rows.push({ ...d, action: call.action, redirect_to: call.to.startsWith("/") ? call.to : "",
        confidence: call.action === "review" ? "Low" : "High",
        method: call.action === "convert" ? `explicit_override,become=${call.to}` : "explicit_override",
        reason: call.why });
      continue;
    }
    // 3. Anything else in the mega-menu stays.
    if (d.inNav) {
      rows.push({ ...d, action: "keep", redirect_to: "", confidence: "High",
        method: d.isPillar ? "pillar" : "nav-child",
        reason: d.isPillar ? "Service pillar — top of the mega-menu." : "Linked from the mega-menu." });
      continue;
    }
    // 4. Any orphan not covered above — scored, and always human-reviewed.
    //    Nothing should reach here today; this is a guard for future re-runs
    //    after the site changes, so a new page can never be silently dropped.
    const m = bestMatch(d, live);
    rows.push({
      ...d, action: "review", redirect_to: "",
      confidence: "Low",
      method: m ? `unclassified,slug=${m.slugJ.toFixed(2)},title=${m.titleJ.toFixed(2)},body=${m.cos.toFixed(2)}` : "none",
      reason: m
        ? `Orphan not covered by an explicit decision. Closest live page is /${m.dst.slug}/. Classify it before shipping.`
        : `Orphan (${d.words}w) with no candidate destination.`,
    });
  }

  rows.sort((a, b) => {
    const order = { keep: 0, convert: 1, redirect: 2, review: 3, delete: 4 };
    return order[a.action] - order[b.action] ||
      ({ High: 0, Medium: 1, Low: 2 }[a.confidence] - { High: 0, Medium: 1, Low: 2 }[b.confidence]) ||
      b.words - a.words;
  });

  const cols = ["slug", "path", "title", "words", "in_nav", "action", "redirect_to", "confidence", "method", "reason"];
  const csv = [
    cols.join(","),
    ...rows.map((r) => cols.map((c) =>
      csvCell(c === "in_nav" ? (r.inNav ? "yes" : "no") : r[c])).join(",")),
  ].join("\n");
  await writeFile(join(OUT, "consolidation-map.csv"), csv + "\n");

  // ---- Non-page URL classes that also 404 at cutover if left unhandled ----
  const infra = [
    ...cats.filter((c) => c.count > 0).map((c) => ({
      from: `/category/${c.slug}/`, to: `/legal-insights/${c.slug}/`,
      // Namespaced under /legal-insights/ deliberately: three category slugs
      // collide with practice-area slugs at the root (litigation-dispute-
      // resolution, company-formation-corporate-services, ...), so a flat
      // /<slug> archive would fight the service page for the same URL.
      note: `Category archive, ${c.count} posts.`,
    })),
    { from: "/author/fakher/", to: "/about-us/", note: "Author archive — single author, thin. 301 rather than rebuild." },
    { from: "/sitemap_index.xml", to: "/sitemap.xml", note: "Yoast index registered in Search Console." },
    { from: "/page-sitemap.xml", to: "/sitemap.xml", note: "Yoast child sitemap." },
    { from: "/post-sitemap.xml", to: "/sitemap.xml", note: "Yoast child sitemap." },
    { from: "/category-sitemap.xml", to: "/sitemap.xml", note: "Yoast child sitemap." },
    { from: "/author-sitemap.xml", to: "/sitemap.xml", note: "Yoast child sitemap." },
    { from: "/feed/", to: "/rss.xml", note: "RSS — serves 200 today; third-party readers still request it." },
    { from: "/comments/feed/", to: "/rss.xml", note: "Comment feed." },
  ];
  await writeFile(join(OUT, "infra-redirects.json"), JSON.stringify(infra, null, 2));

  // ---- Report ----
  const tally = rows.reduce((a, r) => ({ ...a, [r.action]: (a[r.action] ?? 0) + 1 }), {});
  const conf = rows.filter((r) => r.action === "redirect")
    .reduce((a, r) => ({ ...a, [r.confidence]: (a[r.confidence] ?? 0) + 1 }), {});

  console.log(`pages analysed        ${docs.length}`);
  console.log(`reachable from nav    ${docs.filter((d) => d.inNav).length}`);
  console.log(`orphans               ${docs.filter((d) => !d.inNav).length}\n`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(9)} ${String(v).padStart(3)}`);
  }
  console.log(`\nredirect confidence   High ${conf.High ?? 0} · Medium ${conf.Medium ?? 0}`);
  console.log(`resulting live pages  ${tally.keep ?? 0} (+${tally.review ?? 0} needing a decision)`);
  console.log(`infra redirects       ${infra.length}\n`);

  console.log("--- 301 redirects ---");
  for (const r of rows.filter((x) => x.action === "redirect")) {
    console.log(`  /${r.slug}/`.padEnd(44) + `-> ${r.redirect_to}`);
  }
  console.log("\n--- converted, URL preserved (no redirect, no content lost) ---");
  for (const r of rows.filter((x) => x.action === "convert")) {
    const become = r.method.split("become=")[1];
    console.log(`  /${r.slug}/`.padEnd(44) + `-> ${become.padEnd(11)} ${String(r.words).padStart(5)}w`);
  }
  console.log("\n--- needs your decision ---");
  for (const r of rows.filter((x) => x.action === "review")) {
    console.log(`  /${r.slug}/`.padEnd(44) + `${String(r.words).padStart(5)}w  "${r.title}"`);
  }
  const saved = rows.filter((x) => x.action === "convert").reduce((n, r) => n + r.words, 0);
  console.log(`\ncontent retained by converting rather than redirecting: ${saved.toLocaleString()} words`);
  console.log(`\nwritten: ${join(OUT, "consolidation-map.csv")}`);
  console.log(`         ${join(OUT, "infra-redirects.json")}`);
}

main().catch((e) => { console.error("build-consolidation-map failed:", e); process.exit(1); });
