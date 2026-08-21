# Deploying the CMS

Strapi runs as a cPanel **Node.js app** at `cms.fakhernco.com`, against MySQL
on the same account.

## The constraint that shapes everything

The cPanel account caps at **2 GB physical memory** and **9.77 GB disk**, with
20 entry processes. `strapi build` compiles the admin panel and routinely
exceeds that ceiling — the Node.js selector's "Run NPM Install" button hits
the same wall.

**So the build does not happen on the server.** It happens in GitHub Actions —
see *Deploying* below. `app.js` boots from the compiled output and does no
compilation of its own.

Measured, so the numbers are not guesswork: `strapi build` takes **13.9s** and
peaks at **1.69 GB RSS**. The build was never slow. It simply does not fit
beside Passenger and MySQL in 2 GB, which is what produces `spawn node EAGAIN`.

Do **not** reach for `NODE_OPTIONS=--max-old-space-size=1536`, which this file
used to advise. It caps the heap *below* the 1.69 GB the build actually wants,
which converts a tight build into a heap OOM — the opposite of the intent.

## One-time setup

### 1. Database

cPanel prefixes both database and user names with the account, so the real
names are `fakhernco_cms` and `fakhernco_strapi`.

**Create it as `utf8mb4`.** MySQL's legacy 3-byte `utf8` silently mangles
Arabic, curly quotes and dashes — and this site is bilingual.

```sql
CREATE DATABASE fakhernco_cms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Grant the user **ALL PRIVILEGES** on it. Strapi runs a schema sync on every
boot and needs `CREATE`, `ALTER`, `DROP`, `INDEX` and `REFERENCES` — a
locked-down SELECT/INSERT/UPDATE/DELETE user fails at startup.

### 2. Subdomain

cPanel → Domains → create `cms.fakhernco.com`. Point its document root
somewhere outside `public_html` (e.g. `/home/fakhernco/cms`) so the source is
not web-servable.

### 3. Node.js app

cPanel → Software → **Setup Node.js App**:

| Field | Value |
|---|---|
| Node.js version | 22.x |
| Application mode | Production |
| Application root | `cms` |
| Application URL | `cms.fakhernco.com` |
| **Application startup file** | **`app.js`** |

That last field is the one people miss. Passenger ignores `npm start`
entirely; without `app.js` the app never boots and the log says nothing
useful.

### 4. Environment

Set these in the Node.js App interface, not in a committed file:

```
NODE_ENV=production
PUBLIC_URL=https://cms.fakhernco.com
IS_PROXIED=true

DATABASE_CLIENT=mysql
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_NAME=fakhernco_cms
DATABASE_USERNAME=fakhernco_strapi
DATABASE_PASSWORD=…
DATABASE_CHARSET=utf8mb4

APP_KEYS=…            # four comma-separated values
API_TOKEN_SALT=…
ADMIN_JWT_SECRET=…
TRANSFER_TOKEN_SALT=…
JWT_SECRET=…
ENCRYPTION_KEY=…

SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=…
SMTP_PASS=…
SMTP_FROM_EMAIL=…
CONTACT_NOTIFY_EMAIL=…

```

**`REVALIDATE_SECRET` is deliberately not in that list.** Nothing in this
repo reads it — grep `src/`, `config/`, `scripts/` and `app.js` and you will
find no reference. Setting it here does nothing at all.

The value that matters lives in the **webhook row in the database**, typed by
hand into Settings → Webhooks → Headers as `x-revalidate-secret`. That is the
string the front end compares against, so read it out of the admin panel and
paste that exact value into Vercel. Assuming the two are wired through the
environment gets you a 401 on every publish until Strapi disables the webhook
for repeated failures.

**`PUBLIC_URL` and `IS_PROXIED` are not optional.** Unset, Strapi emits
`localhost:1337` media URLs so every image on the site 404s, and it refuses to
set secure cookies so admin login fails with no useful error. Both present as
front-end bugs; both are this file.

Generate every secret fresh:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
```

## Deploying

**Push to `main`.** GitHub Actions builds the admin panel on a Linux runner and
force-pushes a `deploy` branch; the server pulls it within five minutes on a
cPanel cron job. Nothing to run by hand.

```
  push to main
      |
      v
  GitHub Actions ── npm ci ── strapi build ── force-push `deploy` branch
                                                        |
                                    (server reaches OUT, every 5 min)
                                                        v
  cPanel cron ── scripts/cpanel-pull.sh ── rsync into ~/cms ── touch tmp/restart.txt
                                                        |
                                                        v
                                          poll /_health until 204
```

### Why the server pulls instead of CI pushing

The obvious shape is `rsync` over SSH from the runner. It cannot work on this
account, and this was established the hard way:

| Channel | Result |
|---|---|
| SSH port 22 | **connection refused** — nothing listening |
| SSH port 2222 | timed out — firewalled |
| FTP (21) | closed |
| WHM (2087) | reachable, but not accessible to this account |
| cPanel (2083) | reachable |

Nothing inbound is available, and a GitHub runner has no fixed IP to whitelist
even if it were. So the direction is reversed: the box reaches out to GitHub.
cPanel cron is the only scheduler the account reliably exposes, and it runs
shell as the account user, which is all this needs.

The repository is **public**, so the clone needs no credentials. If it is ever
made private this breaks, and the fix is a token — which must not be pasted
into the script, since it would be world-readable on a shared box.

### `NODE_ENV=production` is not optional

```bash
npm run build                      # dist/ = 300KB, NO admin panel
NODE_ENV=production npm run build  # dist/ = 12MB, dist/build/index.html
```

Both print `✔ Building admin panel`. Only the second one actually emits it into
`dist/`. A deploy built without it leaves `cms.fakhernco.com/admin` dead while
the API keeps working — so the CMS looks half-alive and the cause is one
environment variable. The workflow sets it; do not remove it.

### The `deploy` branch

An **orphan** branch, force-pushed as a single rootless commit. `dist/` is 12MB
and would otherwise be appended to history on every push; flat, the branch stays
constant and the server's `--depth=1` clone stays small.

`node_modules` is **not** in it — ~800MB does not belong in git. The server runs
`npm ci --omit=dev` itself, and only when `package-lock.json` actually moves.
That is a download-and-unpack rather than a compile, so it is far lighter than
the build this whole arrangement exists to avoid.

Because the branch is force-pushed with no shared history, `cpanel-pull.sh` uses
`fetch` + `reset --hard`. A `git pull` would fail with "refusing to merge
unrelated histories" on every deploy.

### One-time setup on the box

**cPanel → Cron Jobs**, every five minutes:

```
cd "$HOME" && { [ -d cms-deploy/.git ] || git clone --depth=1 -b deploy https://github.com/nourattorneys-dev/fakhernco-cms.git cms-deploy; /bin/bash cms-deploy/scripts/cpanel-pull.sh; } >> "$HOME/cms-deploy.log" 2>&1
```

That is the whole setup — it clones itself on the first run, which matters
because **Terminal is not available on this account**.

The braces are load-bearing. Without them the redirect covers only the last
command, so a failure in the `git clone` goes to cron's email rather than the
log, and the log stays empty while nothing works.

### Two things this box does not have

Both found the hard way, on the first live run:

**`rsync` is not installed.** The script uses `tar` instead. That is safer here
rather than less: tar only adds and overwrites, so there is no `--delete` to get
wrong and no way for an excluded path to be removed. `dist/` is deleted and laid
down fresh before extraction, because stale admin-panel chunks would otherwise
accumulate on every deploy; it is pure build output and reproduced in full each
time.

**Cron's `PATH` is nearly empty** — typically just `/usr/bin:/bin`, and on a
cPanel box with the Node.js selector `node` and `npm` are not on it at all. The
script extends `PATH` itself, including `/opt/alt/alt-nodejs*/root/usr/bin`.

There are no repository secrets. Nothing to rotate, nothing to leak.

### Watching a deploy

```bash
tail -f ~/cms-deploy.log          # on the box
cat ~/.cms-deployed-sha           # what is actually live
curl -sI https://cms.fakhernco.com/_health   # expect 204
```

The script is quiet when there is nothing to do — it runs 288 times a day, and
logging "no change" every time would bury the one line that matters. It stamps
`~/.cms-deployed-sha` only after `/_health` returns 204, so a failed deploy is
retried on the next tick rather than being recorded as successful.

### Why not build on the box

`strapi build` peaks at **1.69 GB RSS**. The account has 2 GB, shared with
Passenger and MySQL. That is what `spawn node EAGAIN` has been saying.

There is a quieter reason too. Building on an Apple Silicon Mac produces a
**darwin-arm64** `node_modules`, and `sharp` — a hard dependency of
`@strapi/upload` — cannot be loaded on Linux. A hand deploy could complete,
report success, and leave a CMS that will not boot. CI builds on the same
platform the server runs.

### Never run the old rsync

An earlier version of this file documented:

```bash
rsync -az --delete --exclude .git --exclude .env --exclude '.tmp' ./ fakhernco@…:~/cms/
```

**Do not.** It has `--delete` and no `public/uploads/` exclude, so it deletes
the media library — 154 files, gitignored, on that disk and nowhere else. In
rsync an excluded path is also protected from deletion, which is the entire
safety mechanism; never add `--delete-excluded`.

## First boot

`src/index.ts` runs on every boot and is idempotent. It creates the `ar`
locale and grants public `find`/`findOne` on the readable collections, so
neither is a manual admin-panel step.

It deliberately does **not** grant anything on Contact Submission beyond the
custom `submit` action — that collection holds unsolicited enquiries from
prospective clients.

Verify from the front-end repo:

```bash
STRAPI_URL=https://cms.fakhernco.com npm run check:cms
```

## Importing content

Run with the server **stopped** — the scripts boot Strapi in-process and write
directly to the database.

The full sequence, in order. Three commands were listed here before, and they
were not enough: `wp:import` reads `data/content/`, which `wp:extract`
produces — not `wp:fetch` — and the Arabic comes from `wp:scan-ar` and
`wp:fetch-ar`. Running only the first three gave an **English-only site**.

```bash
# Everything below scrapes the LIVE WordPress site. It must still be up.
npm run wp:fetch        # pages, posts, media list, both homepages
npm run wp:map          # classify: keep / convert / redirect / delete
npm run wp:validate     # prove no redirect chains, no dead targets
npm run wp:extract      # raw HTML -> content blocks  (writes data/content)

npm run wp:scan-ar      # which /ar/ URLs are genuinely translated
npm run wp:fetch-ar     # scrape + extract those 53 pages

npm run wp:media        # download + upload to Strapi. Strapi must be STOPPED.
npm run wp:redirects    # emit the 301 map for the web repo

npm run wp:import       # finally. Strapi must be STOPPED.
```

`data/raw/` and `data/content/` are gitignored, so a fresh clone has neither —
they are regenerated by the commands above. That is why the whole sequence has
to run **before the WordPress site is switched off**, not just `wp:media`.

`wp:import` refuses to run without `data/content` and tells you so. Missing
Arabic used to be silent; it now prints a warning and reports zero Arabic
localisations in its summary. Check that number before you consider the
import finished — it should be 53.

**Once the firm starts editing in the admin panel, never run `wp:import`
against that database again.** It overwrites whole records and would silently
revert their work. Re-import only into a fresh database.


## Email (Resend)

The contact form stores every enquiry in the CMS regardless. Email only
controls the *notification* to the firm and the *auto-reply* to the client —
but without it nobody learns an enquiry arrived until someone opens the admin
panel, which for paid traffic means a slow lead.

### Why not Microsoft or cPanel

`fakhernco.com` has MX at Microsoft 365 and this SPF:

```
v=spf1 include:spf.protection.outlook.com include:spf-de.emailsignatures365.com -all
```

The trailing `-all` is a hard fail: receiving servers are told to REJECT mail
from this domain that did not come via Microsoft.

- **cPanel mail** is not in that list. Auto-replies would be rejected or
  spam-filed.
- **Microsoft 365 SMTP** is aligned, but basic SMTP AUTH is off by default on
  modern tenants and is being retired. The endpoint advertises `AUTH LOGIN`;
  whether a mailbox may use it is a per-tenant flag only an admin can read.

### Setup

1. Create a Resend account and add the domain **`fakhernco.com`** — the root,
   so the auto-reply a prospective client receives comes from
   `noreply@fakhernco.com` rather than from something that reads as plumbing.

2. Resend shows the DNS records to add. Read them carefully before touching
   anything, because one of them is the record the firm's real email depends
   on:

   - **DKIM** (`resend._domainkey`) — a new TXT record. No conflict. This is
     what authenticates the From address, and on its own it is usually enough
     for a root From address to be accepted.
   - **MX and SPF on a `send.` subdomain** — Resend uses this for bounces and
     the return-path. New records, nothing existing touched.
   - **If, and only if, Resend asks for an SPF include on the ROOT domain**,
     APPEND it to the existing record. Do not retype the line:

     ```
     v=spf1 include:spf.protection.outlook.com \
            include:spf-de.emailsignatures365.com \
            include:_spf.resend.com -all
     ```

     Keep `-all` at the end. It is the strict setting and it is correct — it
     is what stops anyone spoofing the firm's address. There is headroom:
     SPF allows 10 DNS lookups and this record currently uses 2.

   **Never add an MX record to the ROOT domain.** The root MX points at
   Microsoft 365 and is how the firm receives all of its mail. Resend's MX
   belongs on the `send.` subdomain only.

   Add the records in cPanel → **Zone Editor**, or in Cloudflare if that is
   authoritative for DNS.

3. Wait for Resend to show the domain **Verified**.

4. Create an API key, then set on the server:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<the API key>
SMTP_FROM_EMAIL=noreply@fakhernco.com
CONTACT_NOTIFY_EMAIL=info@fakhernco.com
```

`SMTP_USER` really is the literal string `resend`. The API key is the
password.

### Verifying it works

Submit a real enquiry on the live site and check three things, in this order:

1. The submission appears in the admin panel under **Contact submission**
2. `CONTACT_NOTIFY_EMAIL` receives the alert, and pressing Reply addresses the
   client rather than the server
3. The address used in the form receives the auto-reply, **and it is not in
   the junk folder** — check that explicitly, since it is the failure this
   whole setup exists to avoid

If step 1 works and 2 and 3 do not, the credentials are wrong and Strapi will
have logged it. If none work, the submission itself failed.

## Things that have actually gone wrong on this stack

**Never use `strapi transfer` to seed a remote instance.** It overwrites
`admin::user`, `admin::role` and `admin::transfer-token` on the destination —
deleting the token it is authenticating with and locking you out of an admin
panel you may not be able to reach by shell.

**Media lives on disk** in `public/uploads`, not in the database. It is not in
git. Back it up separately, and never let a deploy delete it.

**Contact notifications fail silently.** Without `SMTP_*` and
`CONTACT_NOTIFY_EMAIL` the form still saves every enquiry and only logs a
warning — no lead is lost, but nobody is told. Test with a real submission
after every environment change.
