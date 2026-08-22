# fakhernco-cms

Strapi 5 CMS for [fakhernco.com](https://fakhernco.com) — Fakher & Co, UAE law
firm. Serves the [`fakhernco-web`](https://github.com/nourattorneys-dev/fakhernco-web)
front end over REST.

Also home to the WordPress migration tooling, in [`migration/`](./migration).

## Status

Strapi scaffolding pending. The migration analysis is done: see
[`migration/README.md`](./migration/README.md) for the consolidation map, the
content extractor and the block contract the content model is built from.

## Stack

| | |
|---|---|
| CMS | Strapi 5.51, TypeScript |
| Database | MySQL 8, **utf8mb4** |
| Locales | i18n plugin, English + Arabic |
| Media | local upload provider, persistent disk |
| Email | `@strapi/provider-email-nodemailer` over Microsoft 365 |
| Hosting | cPanel Node.js app at `cms.fakhernco.com` |

## Non-negotiables

**Create the database as `utf8mb4`.** MySQL's legacy 3-byte `utf8` silently
mangles Arabic, curly quotes and dashes. This has already cost time on a sibling
project.

```sql
CREATE DATABASE x CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

**Enable the i18n plugin before the first import**, not after. Retrofitting
localised fields onto populated content types is far more work than starting
with them.

**Set `PUBLIC_URL` in production.** Unset, Strapi emits `localhost:1337` media
URLs and every image on the site 404s — a front-end symptom with a CMS cause.

**Set `IS_PROXIED` behind the cPanel proxy**, or admin login fails with no
useful error.

**Never run `strapi transfer` against a remote instance.** It overwrites
`admin::user`, `admin::role` and `admin::transfer-token` on the destination,
deleting the token it is authenticating with and locking you out of an admin
panel you may not be able to reach by shell.

## Migration tooling

```bash
npm run wp:fetch      # pull the live WordPress inventory
npm run wp:map        # build the consolidation / redirect table
npm run wp:validate   # prove the map is shippable
npm run wp:extract    # Bold Builder markup -> portable blocks
```

See [`migration/README.md`](./migration/README.md).
