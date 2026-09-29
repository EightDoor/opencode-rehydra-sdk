export { createRehydraPlugin } from "rehydra/opencode-plugin";
export type { RehydraPluginOptions } from "rehydra/opencode-plugin";

/**
 * The pre-built plugin instance exported by `@rehydra/opencode`.
 *
 * The type is taken from the package's own build output
 * (`rehydra/opencode-plugin`) instead of being re-declared here, so it always
 * matches the OpenCode V2 `Plugin` shape (`id` + `setup`).
 */
export declare const rehydra: typeof import("rehydra/opencode-plugin").plugin;
export default rehydra;
