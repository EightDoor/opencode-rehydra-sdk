// Loads the published V2 SDK. Resolves to `opencode-rehydra-core`'s
// `opencode-plugin` entry via its `exports` map, so the plugin works from an
// npm install (no in-repo `dist/` required at runtime).
const sdk = await import("opencode-rehydra-core/opencode-plugin");
const sdkDefault = sdk.default;
const sdkPlugin = sdk.plugin;
const sdkCreate = sdk.createRehydraPlugin;
export { sdkDefault as default, sdkPlugin as plugin, sdkCreate as createRehydraPlugin };
// Backwards-compatible named export for consumers that still use the V1-style
// entry: `import rehydra from "@rehydra/opencode"`. V2 reads the default
// export, but keep `rehydra` available for code that imports it explicitly.
export const rehydra = sdkDefault;