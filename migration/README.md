# Migration tooling

Everything that moves fakhernco.com off WordPress lives here and is committed.
On the previous migration the scripts that did the real work — the scraper, the
redirect matcher, the duplicate clusterer — were run from a scratchpad and never
committed, so only their invocations survived. Not repeating that.

## Running order

```bash
node migration/scripts/fetch-wp.mjs                # pull the live inventory
node migration/scripts/build-consolidation-map.mjs # propose keep/redirect/convert
node migration/scripts/validate-consolidation.mjs --live
```

`data/raw/` is gitignored — it is a cache of the live site, re-fetchable until
cutover. `out/` is committed: those are decision artifacts.

## Scripts

| Script | Does |
|---|---|
| `fetch-wp.mjs` | Pulls pages, posts, categories, tags, media and both homepages from `wp-json` into `data/raw/`. |
| `build-consolidation-map.mjs` | Classifies all 80 pages and writes `out/consolidation-map.csv` + `out/infra-redirects.json`. |
| `validate-consolidation.mjs` | Proves the map is shippable: no chains, no self-loops, no dead targets, no dropped pages. `--live` also confirms every target returns 200 today. |

## Gotchas that are not optional

**Cloudflare 403s any non-browser User-Agent.** Every request in `fetch-wp.mjs`
sends a real Chrome UA. Without it, *every* URL returns 403 — including sitemaps
and `wp-json`. There is no CAPTCHA or rate limit behind it.

**The sitemap is only half the site.** `sitemap_index.xml` lists 228 English
URLs and zero `/ar/` URLs. Arabic slugs mirror English exactly, so enumerate
them by prefixing `/ar/`.

**Arabic is not in `post_content`.** TranslatePress keeps translations in
`wp_trp_dictionary`. A WXR export or a REST content dump captures none of it —
that needs a separate DB-level export via cPanel.

## How the consolidation map was built

Pure similarity clustering was tried first and abandoned. These pages are short
and share heavy boilerplate, so TF-IDF cosine was actively misleading:

| pair | cosine | title Jaccard |
|---|---|---|
| `private-notary-services` ~ `private-notary-attestation-services` | 0.275 | 0.750 |
| `litigation` ~ `litigation-dispute-resolution` | 0.238 | 0.333 |
| `lawyer-attestation` ~ `lawyer-attestation-2` | 0.545 | 0.333 |

The site is really three tiers — 5 pillars (~2,300w, in the mega-menu), ~40
children (~600w, in the menu), and 20 orphans (~600w, linked from nothing) —
and duplication is almost always "an old v1 page superseded by a newer one".

So classification is by navigation reachability, and every orphan was read
before being assigned an action. That mattered: scoring alone proposed
redirecting all 20 orphans onto service pages, which would have discarded
**6,007 words** of usable content. Reading them showed four families:

1. **Superseded v1 service pages** (7) — identical `OUR FOCUS` opener and
   `h2=6/h3=2` skeleton, each already replaced by a menu page. These 301.
2. **Editorial guides misfiled as Pages** (6) — real top-of-funnel articles,
   currently orphaned and invisible. Convert to Insights, **keep the URL**.
3. **Anonymised case studies** (2) — needs a Case Study content type the model
   did not have. Convert, keep the URL.
4. **SKP Business Federation section** (3) — supports `/skp-business-federation/`,
   which is menu-linked via its logo. Keep, and link properly.

## Current result

| Action | Count |
|---|---|
| keep | 62 |
| convert (URL preserved) | 8 |
| redirect (301) | 8 |
| review (firm decides) | 1 |
| delete (410) | 1 |

Plus 15 infrastructure redirects in `out/infra-redirects.json` for URL classes
that are not pages and would otherwise 404 at cutover: 7 category archives, the
author archive, the six Yoast sitemap URLs and the RSS feeds.

`/legal-consultations/` is the one open item — a v1 service page that nothing
replaced. Restore it as a service or retire it; that is a commercial call.
