"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config = ({ env }) => ({
    host: env('HOST', '0.0.0.0'),
    port: env.int('PORT', 1337),
    /**
     * Public URL of this instance, e.g. https://cms.fakhernco.com
     *
     * Required in production behind a reverse proxy. Strapi builds admin-panel
     * and media links from it; left unset it emits http://localhost:1337 URLs,
     * which breaks the admin panel and every image on the front end. That
     * failure presents as a front-end bug but the cause is here.
     */
    url: env('PUBLIC_URL', undefined),
    /**
     * Trust the X-Forwarded-* headers from the cPanel/nginx proxy.
     *
     * Without this Strapi believes every request arrived over plain HTTP on
     * localhost, so it refuses to set `secure` cookies and admin login fails
     * with no useful error - the most common self-hosted misconfiguration.
     */
    proxy: env.bool('IS_PROXIED', false),
    app: {
        keys: env.array('APP_KEYS'),
    },
    webhooks: {
        // Send the full entry so the Next.js /api/revalidate webhook can read
        // entry.slug and entry.locale and invalidate the exact page.
        populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', true),
    },
});
exports.default = config;
