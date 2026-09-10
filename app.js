/**
 * Passenger entry point for the cPanel Node.js app.
 *
 * cPanel's Node.js selector runs the application through Phusion Passenger,
 * which requires a fixed startup file and IGNORES `npm start` entirely. Set
 * "Application startup file" to `app.js` in the Node.js App interface.
 *
 * Passenger also supplies its own listening socket, so the app must NOT bind
 * a port of its own. Strapi reads HOST/PORT from config/server.ts; leaving
 * PORT unset here lets Passenger hand it the socket it expects.
 *
 * This file deliberately does no work beyond booting Strapi from the compiled
 * output — `npm run build` must have been run first, off-box. See DEPLOYMENT.md
 * for why the build does not happen on the server.
 *
 * WHY NOT compileStrapi(): it used to, and that contradicted the paragraph
 * above. compileStrapi() rebuilds the admin panel whenever `typescript` is
 * resolvable, which on this 2 GB account peaks near 1.9 GB — over the
 * CloudLinux cap, so the boot was SIGKILLed (exit 137) before it could bind a
 * port or write a single log line. Passenger then respawned it, indefinitely.
 * That loop, not traffic and not memory pressure, is what exhausted the
 * account's entry processes and CPU and returned 508 to every request —
 * including Strapi's own startup, which made it self-sustaining.
 *
 * Passing distDir explicitly runs the CI-built output and boots in ~6s. Note
 * this is also robust to `typescript` reappearing: a stray `npm install` can
 * no longer resurrect the boot-time build. If a build ever looks stale, fix it
 * in CI — do not reintroduce compileStrapi() here. The server has no headroom
 * to compile anything.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const path = require('path');
const { createStrapi } = require('@strapi/strapi');

(async () => {
  try {
    const app = await createStrapi({
      appDir: process.cwd(),
      distDir: path.resolve(process.cwd(), 'dist'),
    }).load();
    await app.start();
  } catch (error) {
    // Passenger surfaces stderr in the cPanel error log; without this the
    // app simply fails to start with no explanation.
    console.error('[strapi] failed to start:', error);
    process.exit(1);
  }
})();
