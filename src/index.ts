import type { Core } from '@strapi/strapi';

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
] as const;

const PUBLIC_ACTIONS = ['find', 'findOne'] as const;

/** Locales the site ships. `en` is Strapi's default and always exists. */
const LOCALES = [{ code: 'ar', name: 'Arabic (ar)' }];

export default {
  register(_: { strapi: Core.Strapi }) {},

  /**
   * Runs on every boot, idempotently.
   *
   * Both steps below are otherwise manual admin-panel clicking that is easy to
   * forget, and both fail in ways that look like front-end bugs: a missing
   * locale makes every Arabic request 404, and missing public permissions make
   * every collection return 403 while the CMS itself looks perfectly healthy.
   *
   * Doing it here rather than in a seed script matters because the REST API
   * cannot grant its own permissions - so on a remote deploy this is otherwise
   * admin-panel clicking on a box you may only reach over SSH.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await ensureLocales(strapi);
    await grantPublicRead(strapi);
  },
};

async function ensureLocales(strapi: Core.Strapi) {
  const service = strapi.plugin('i18n')?.service('locales');
  if (!service) return;

  const existing: Array<{ code: string }> = await service.find();
  const have = new Set(existing.map((l) => l.code));

  for (const locale of LOCALES) {
    if (have.has(locale.code)) continue;
    await service.create(locale);
    strapi.log.info(`[bootstrap] created locale ${locale.code}`);
  }
}

async function grantPublicRead(strapi: Core.Strapi) {
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

      if (existing?.enabled) continue;

      if (existing) {
        await strapi
          .query('plugin::users-permissions.permission')
          .update({ where: { id: existing.id }, data: { enabled: true } });
      } else {
        await strapi
          .query('plugin::users-permissions.permission')
          .create({ data: { action, role: role.id, enabled: true } });
      }
      granted += 1;
    }
  }

  if (granted) strapi.log.info(`[bootstrap] granted ${granted} public read permission(s)`);
}
