/* The wire-contract version this client speaks (DAWN's `protocol`, on `config` and
   /api/auth/status). DAWN bumps it only when something is removed or changes incompatibly;
   anything new or changed rides a named flag in `features` instead. Its own module, with no
   imports, so the build can stamp it into the release manifest (vite.config.ts,
   aurora-release.json): DAWN's packaging reads it there to tell whether an Aurora release speaks
   its protocol before bundling it. */
export const CLIENT_PROTOCOL = 1;
