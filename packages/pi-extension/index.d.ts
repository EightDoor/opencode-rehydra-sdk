/**
 * Type entry for the published `@rehydra/pi-extension` package.
 *
 * Types are re-exported from the SDK build output, so they always match the
 * implementation that Pi loads at runtime.
 */
export {
  default,
  createRehydraPiExtension,
} from "./dist/pi-extension/index.js";
export type { RehydraPiExtensionOptions } from "./dist/pi-extension/index.js";