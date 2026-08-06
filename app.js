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
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { createStrapi, compileStrapi } = require('@strapi/strapi');

(async () => {
  try {
    const app = await createStrapi(await compileStrapi()).load();
    await app.start();
  } catch (error) {
    // Passenger surfaces stderr in the cPanel error log; without this the
    // app simply fails to start with no explanation.
    console.error('[strapi] failed to start:', error);
    process.exit(1);
  }
})();
