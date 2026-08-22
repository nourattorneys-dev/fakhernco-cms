"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config = [
    /*
      Before everything else, deliberately.
  
      /_deployed must answer even when the rest of the stack is unhappy — a CMS
      that cannot serve content is exactly when you need to know which revision
      is running. Sitting ahead of errors, security and body parsing keeps it
      answerable, and it is a plain GET with no side effects.
    */
    'global::deployed',
    'strapi::logger',
    'strapi::errors',
    'strapi::security',
    'strapi::cors',
    'strapi::poweredBy',
    'strapi::query',
    'strapi::body',
    'strapi::session',
    'strapi::favicon',
    'strapi::public',
];
exports.default = config;
