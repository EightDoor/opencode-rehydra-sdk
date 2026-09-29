// Load the built V2 SDK from the sibling bundled `dist/` directory. The
// plugin package copies its slice of the root `dist/opencode-plugin/` output
// into `./dist/` during the `prepublishOnly` step, so this works both in the
// monorepo (where `./dist/` is a fresh copy of `../../dist/opencode-plugin/`)
// and from a published npm install (where `./dist/` ships inside the tarball).
const sdk = await import("./dist/opencode-plugin/index.js");
const sdkDefault = sdk.default;
const sdkPlugin = sdk.plugin;
const sdkCreate = sdk.createRehydraPlugin;
export { sdkDefault as default, sdkPlugin as plugin, sdkCreate as createRehydraPlugin };
// Backwards-compatible named export for consumers that still use the V1-style
// entry: `import rehydra from "@rehydra/opencode"`. V2 reads the default
// export, but keep `rehydra` available for code that imports it explicitly.
export const rehydra = sdkDefault;