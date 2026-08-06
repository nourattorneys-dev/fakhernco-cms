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
| `extract-content.mjs` | Converts Bold Builder markup into portable blocks. Writes `data/content/{pages,posts}/<slug>.json` + `out/extraction-report.json`. |
| `import.mjs` | Loads the extracted content into Strapi, applying the consolidation map. `--dry` reports the plan without writing. |

## Block contract

Every extracted document is `{ slug, legacyUrl, title, date, modified, blocks[], unhandled[] }`
(posts add `excerpt` and `categories[]`). The block union:

```
heading    { level: 1-6, text }
paragraph  { html }                     inline <strong> <em> <a> <u> preserved
list       { ordered, items[] }
table      { headers[], rows[][] }
faq        { items: [{ question, answer }] }
cards      { items: [{ title, text, href? }] }
image      { src, alt }                 src resolved to the original upload
button     { text, href }
quote      { html }
```

`unhandled[]` records any visible text that did not land in a block. It must
stay empty-ish: a page that extracts to nothing still returns 200 and would
pass every downstream check, so this is the only thing standing between a
parser regression and silently shipping an empty page.

## Extraction results

| | Documents | Mean text coverage | ≥90% captured | Mean blocks/doc |
|---|---|---|---|---|
| Posts | 140 | **100.0%** | 140 | 65.4 |
| Pages | 80 | **98.0%** | 79 | 21.4 |

The only document below 90% is `/footer/`, which is being deleted anyway. Block
totals across all 220 documents: 4,933 paragraphs, 3,742 headings, 1,533 lists,
248 tables, 154 buttons, 146 FAQs, 107 images, 4 card grids, 1 quote.

**No page needs its content re-authored by hand.** The earlier estimate assumed
~30 layout-heavy pages would. They extract at ≥90% like everything else — what
they need is a good template, because they are heading / paragraph / card /
button sequences rather than prose.

### Two bugs worth remembering

**`wpautop` wraps the entire builder output in a single `<p>`.** A naive "bare
semantic tag is a leaf" rule therefore swallows a whole document into one
paragraph block. Guard with `hasBlockDescendant()`.

**Text coverage measured as a capped length ratio reads 100% while that is
happening**, because all the text *is* present — in one useless blob. Coverage
is now multiset token recall, which caught it immediately. Never measure
extraction quality with a ratio that can saturate.

## Import

```bash
npm run wp:import -- --dry   # plan only
npm run wp:import            # write (Strapi server must be STOPPED)
```

The consolidation map decides what happens to each page:

| Map action | Import result |
|---|---|
| `keep` | Page — or **Practice area** for the five pillars |
| `convert` | Insight or Case study, URL preserved |
| `redirect` | **not imported** — it becomes a 301, and importing it would recreate the duplicate |
| `delete` | **not imported** |
| `review` | imported as a **draft**, visible to the firm but not publicly reachable |

Result of the current run:

| | |
|---|---|
| Pages | 58 (57 published + `legal-consultations` as draft) |
| Insights | 146 — 140 blog posts + 6 converted guides |
| Case studies | 2 |
| Practice areas | 5 |
| Categories | 7 |
| Not imported | 9 (8 redirects + `/footer/`) |

Idempotent: a second run produces 0 creates and 218 updates. Pillar→child
relations are derived from mega-menu link order (44 children mapped), because
`/wp-json/wp/v2/menus` returns 401 without authentication.

**Hard rule:** once the firm starts editing in the admin panel, do not run this
against that database again. It overwrites whole records and would silently
revert their work. Re-import only into a fresh database.

### SEO metadata

`yoast_head_json` is exposed on the REST API, so meta title, description,
canonical and robots directives migrate with the content — 220/220 documents
carry Yoast metadata and 219 have a meta description. Without it the rebuild
would invent new metadata for 220 ranking pages.

The brand suffix is stripped on the way in. Every stored title currently ends
with `- Fakher & Co`, and the Next.js title template appends the brand itself,
so leaving both produces `Fakher & Co | About Us - Fakher & Co`.

### Two Strapi-specific traps

**Strapi's ESM build cannot be imported from an ESM script.** `@strapi/strapi`'s
`.mjs` entry does a directory import of `lodash/fp`, which Node's ESM resolver
rejects outright with `ERR_UNSUPPORTED_DIR_IMPORT`. Load the CommonJS entry via
`createRequire` instead — this is why t4me's importer is CommonJS.

**Use `compileStrapi()`, not a hand-built config object.** Constructing
`createStrapi({appDir, distDir})` directly leaves `db.config.connection`
undefined, because `config/database.ts` never gets compiled or read.

## Finding: 222 stray H1s, not 49 documents

The document-level count was 49; the import demoted **222 individual H1 blocks**
to H2. One "heading" also exceeded 255 characters and was reclassified as a
paragraph — it was prose the theme happened to render inside a headline block.

## Finding: 49 documents carry more than one H1

Not a migration artifact — it is how the theme renders. `bt_bb_headline_tag` is
set per headline block, and authors picked `h1` repeatedly.
`/understanding-legal-costs/` has **seven**. The homepage has six. This is a
site-wide on-page defect the rebuild fixes by construction: one H1 per page,
enforced by the template rather than by the editor's choice.

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
