# fakhernco-cms

Strapi 5 CMS for fakhernco.com, running as a cPanel Node.js app at
`cms.fakhernco.com` (2 GB RAM — this number shapes everything). The front end
is the separate repo `../fakhernco-web`, on Vercel.

## Deploying

Push to `main`. GitHub Actions builds the admin panel and force-pushes an
orphan `deploy` branch; a **cPanel cron job** on the server pulls it within
5 minutes (`scripts/cpanel-pull.sh`), syncs into `~/cms` with tar, touches
`tmp/restart.txt`, and polls `/_health` until 204. Nothing manual, no secrets.

```bash
curl -s https://cms.fakhernco.com/_deployed   # commit + boot time of the RUNNING process
```

Why this shape: **nothing inbound reaches the box.** SSH is refused on 22,
filtered on 2222, FTP closed, WHM inaccessible. The server pulls; CI never
pushes to it. The repo is public, so the clone needs no credentials.

## The three hard constraints

1. **`NODE_ENV=production npm run build`** — without the env var the build
   prints "✔ Building admin panel" and emits a 300 KB `dist/` with **no admin
   panel in it**. Deploying that leaves `/admin` dead while the API works.
2. **Never build on a Mac and copy `node_modules`** — darwin-arm64 `sharp`
   cannot load on Linux; the deploy reports success and Strapi won't boot.
3. **`public/uploads/` exists only on the server's disk** (154 files, no
   backup in git). Any sync must exclude it. The old rsync command in git
   history deletes it — never resurrect it.

## Locales

`en` (default), `ar`, `de` — created idempotently by `ensureLocales` in
`src/index.ts` on every boot. Strapi quirks that matter:

- An **unknown locale returns an empty 200**, not an error — `?locale=zz`
  looks exactly like `?locale=de`. Never use an empty list as proof a locale
  is missing (or present).
- A **single type with no localisation returns 404** (collections return
  empty). The front end treats that 404 as "not translated yet".

The contact controller (`src/api/contact-submission/controllers/submit.ts`)
holds per-locale auto-reply copy; German is marked non-native. `consent`
accepts boolean **and** the string `"true"` — FormData sends strings, and the
strict `=== true` comparison once recorded `consent: false` on every enquiry.

## Scripts

Seed scripts (`remote-seed*.mjs`) iterate a `TRANSLATED` list — keep `de` in it.
They need the seed token and read/write production; there is no safe dry run
against a live editing session. `npm run verify:email-dns` checks the mail
records without credentials.

Content editing needs **no deploy** — it happens in the admin panel. Deploys
are only for code, which changes rarely.

Full reasoning and history: `DEPLOYMENT.md`.
