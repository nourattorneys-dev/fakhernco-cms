# Deploying the CMS

Strapi runs as a cPanel **Node.js app** at `cms.fakhernco.com`, against MySQL
on the same account.

## The constraint that shapes everything

The cPanel account caps at **2 GB physical memory** and **9.77 GB disk**, with
20 entry processes. `strapi build` compiles the admin panel with webpack and
routinely exceeds that ceiling — the Node.js selector's "Run NPM Install"
button hits the same wall.

**So the build does not happen on the server.** Build locally or in CI, then
upload `dist/` and `node_modules/` alongside the source. `app.js` boots from
the compiled output and does no compilation of its own.

If you ever do try building on-box, cap the heap first and expect it to be
slow:

```bash
NODE_OPTIONS=--max-old-space-size=1536 npm run build
```

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

REVALIDATE_SECRET=…   # must match the front end
```

**`PUBLIC_URL` and `IS_PROXIED` are not optional.** Unset, Strapi emits
`localhost:1337` media URLs so every image on the site 404s, and it refuses to
set secure cookies so admin login fails with no useful error. Both present as
front-end bugs; both are this file.

Generate every secret fresh:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
```

## Deploying

```bash
# Locally
npm ci
npm run build                     # produces dist/
rsync -az --delete \
  --exclude .git --exclude .env --exclude '.tmp' \
  ./ fakhernco@158.220.82.191:~/cms/

# Then in cPanel: Node.js App -> Restart
```

`public/uploads/` is gitignored and must NOT be part of a `--delete` sync, or
you will wipe the media library. Either exclude it explicitly or sync it
separately.

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

```bash
npm run wp:fetch
npm run wp:media      # BEFORE the old WordPress goes away
npm run wp:import
```

**Once the firm starts editing in the admin panel, never run `wp:import`
against that database again.** It overwrites whole records and would silently
revert their work. Re-import only into a fresh database.

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
