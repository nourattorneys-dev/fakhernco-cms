"use strict";
/**
 * GET /_deployed — what revision is actually running.
 *
 * WHY THIS EXISTS
 * The front end has /api/version for exactly this reason, and its docblock
 * records the cost of not having one: "the developer rebuilt and nothing
 * changed" burned several rounds of guessing, because from outside there is no
 * way to tell a stale cache from an old build from a process that was never
 * restarted. Each has a different fix and they look identical.
 *
 * The CMS had the same problem and no such endpoint, which became obvious the
 * first time a deploy needed verifying: /_health returns 204 whether the code
 * is current or a month old, and /api/i18n/locales is 403 to the public. Worse,
 * the obvious probe LIES — Strapi answers ?locale=de with an empty list whether
 * or not that locale exists, so `?locale=zz` looks exactly as healthy. A check
 * that cannot fail is not a check.
 *
 * The commit is read once, at boot. That is deliberate: it reports the revision
 * this PROCESS started from, so a deploy that copied files but never restarted
 * Passenger still shows the old SHA — which is precisely the failure worth
 * catching, and a per-request read would hide it by reporting the new file.
 *
 * DEPLOY_SHA is written by the publish workflow. A local `strapi develop` has
 * no such file and reports "dev", which is honest rather than a lie about
 * being some release.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
function readSha() {
    for (const candidate of ['DEPLOY_SHA', '../DEPLOY_SHA']) {
        try {
            const value = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), candidate), 'utf8').trim();
            if (value)
                return value;
        }
        catch {
            // Next candidate. A missing file is the normal local case, not an error.
        }
    }
    return 'dev';
}
exports.default = (_config, { strapi }) => {
    // Both captured at boot, for the reason in the docblock above.
    const commit = readSha();
    const startedAt = new Date().toISOString();
    strapi.log.info(`[deployed] running ${commit}`);
    return async (ctx, next) => {
        var _a;
        if (ctx.path !== '/_deployed')
            return next();
        ctx.set('cache-control', 'no-store, must-revalidate');
        ctx.body = {
            commit,
            startedAt,
            node: process.version,
            env: (_a = process.env.NODE_ENV) !== null && _a !== void 0 ? _a : 'unknown',
        };
    };
};
