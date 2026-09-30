// Entry point for the published `@rehydra/pi-extension` package.
//
// Pi loads this module's default export as the Extension factory after the
// package is installed with `pi install npm:@rehydra/pi-extension`. The real
// implementation lives in `./dist/pi-extension/index.js`, copied from the SDK
// build output by `scripts/sync-dist.mjs` during `prepublishOnly`.
export { default, createRehydraPiExtension } from "./dist/pi-extension/index.js";