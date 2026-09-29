// Load the built V2 SDK directly from the sibling dist/ directory so this
// package can be dropped into OpenCode's plugin config without requiring an
// npm install of the `rehydra` package. The relative path resolves to the
// repository's compiled output (`../../dist/opencode-plugin/index.js`).
const sdk = await import("../../dist/opencode-plugin/index.js");
const sdkDefault = sdk.default;
const sdkPlugin = sdk.plugin;
const sdkCreate = sdk.createRehydraPlugin;
export { sdkDefault as default, sdkPlugin as plugin, sdkCreate as createRehydraPlugin };
// Backwards-compatible named export for consumers that still use the V1-style
// entry: `import rehydra from "@rehydra/opencode"`. V2 reads the default
// export, but keep `rehydra` available for code that imports it explicitly.
export const rehydra = sdkDefault;
