/**
 * Public contact endpoint.
 *
 * Separate from the generated core router so that the collection's own
 * find/findOne stay private. Enquiries to a law firm are confidential; only
 * this write action is exposed.
 */
export default {
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
