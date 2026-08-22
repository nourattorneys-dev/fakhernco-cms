"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Public contact endpoint.
 *
 * Separate from the generated core router so that the collection's own
 * find/findOne stay private. Enquiries to a law firm are confidential; only
 * this write action is exposed.
 */
exports.default = {
    routes: [
        {
            method: 'POST',
            path: '/contact',
            handler: 'submit.create',
            config: {
                auth: false,
                policies: [],
                middlewares: [],
            },
        },
    ],
};
