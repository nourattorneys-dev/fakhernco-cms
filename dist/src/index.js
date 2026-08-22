"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Content types the front end reads anonymously.
 *
 * Contact Submission is deliberately absent: it holds unsolicited enquiries
 * from a law firm's prospective clients, and `find`/`findOne` on it would
 * expose every one of them. Only its custom `submit` action is public.
 */
const PUBLIC_READ = [
    'api::page.page',
    'api::post.post',
    'api::case-study.case-study',
    'api::practice-area.practice-area',
    'api::category.category',
    'api::office.office',
    'api::team-member.team-member',
    'api::homepage.homepage',
    'api::site-setting.site-setting',
    'api::landing-page.landing-page',
];
const PUBLIC_ACTIONS = ['find', 'findOne'];
/** Locales the site ships. `en` is Strapi's default and always exists. */
const LOCALES = [
    { code: 'ar', name: 'Arabic (ar)' },
    { code: 'de', name: 'German (de)' },
];
exports.default = {
    register(_) { },
    /**
     * Runs on every boot, idempotently.
     *
     * Both steps below are otherwise manual admin-panel clicking that is easy to
     * forget, and both fail in ways that look like front-end bugs: a missing
     * locale makes every request in that language 404, and missing public
     * permissions make every collection return 403 while the CMS itself looks
     * perfectly healthy.
     *
     * Adding a locale here is safe on an existing database: ensureLocales
     * set-diffs against what already exists, and permissions carry no locale
     * dimension — a `find` grant already covers `?locale=de`.
     *
     * Doing it here rather than in a seed script matters because the REST API
     * cannot grant its own permissions - so on a remote deploy this is otherwise
     * admin-panel clicking on a box you may only reach over SSH.
     */
    async bootstrap({ strapi }) {
        await ensureLocales(strapi);
        await grantPublicRead(strapi);
    },
};
async function ensureLocales(strapi) {
    var _a;
    const service = (_a = strapi.plugin('i18n')) === null || _a === void 0 ? void 0 : _a.service('locales');
    if (!service)
        return;
    const existing = await service.find();
    const have = new Set(existing.map((l) => l.code));
    for (const locale of LOCALES) {
        if (have.has(locale.code))
            continue;
        await service.create(locale);
        strapi.log.info(`[bootstrap] created locale ${locale.code}`);
    }
}
async function grantPublicRead(strapi) {
    const role = await strapi
        .query('plugin::users-permissions.role')
        .findOne({ where: { type: 'public' } });
    if (!role) {
        strapi.log.warn('[bootstrap] no public role found; skipping permission grant');
        return;
    }
    let granted = 0;
    for (const uid of PUBLIC_READ) {
        for (const verb of PUBLIC_ACTIONS) {
            const action = `${uid}.${verb}`;
            const existing = await strapi
                .query('plugin::users-permissions.permission')
                .findOne({ where: { action, role: role.id } });
            if (existing === null || existing === void 0 ? void 0 : existing.enabled)
                continue;
            if (existing) {
                await strapi
                    .query('plugin::users-permissions.permission')
                    .update({ where: { id: existing.id }, data: { enabled: true } });
            }
            else {
                await strapi
                    .query('plugin::users-permissions.permission')
                    .create({ data: { action, role: role.id, enabled: true } });
            }
            granted += 1;
        }
    }
    if (granted)
        strapi.log.info(`[bootstrap] granted ${granted} public read permission(s)`);
}
