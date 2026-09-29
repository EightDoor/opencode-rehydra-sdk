#!/usr/bin/env node
// Sync the repo root's `dist/` build output into this package's own `dist/`
// directory. The plugin entry imports the SDK from
// `./dist/opencode-plugin/index.js`, which transitively reaches
// `./dist/core/`, `./dist/types/`, `./dist/storage/`, etc. — so we copy the
// whole `dist/` tree, not only the opencode-plugin slice.
import { cp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const srcDir = path.join(repoRoot, "dist");
const dstDir = path.join(pkgRoot, "dist");

await rm(dstDir, { recursive: true, force: true });
await mkdir(dstDir, { recursive: true });
await cp(srcDir, dstDir, { recursive: true });
console.log(`synced ${path.relative(repoRoot, srcDir)} -> ${path.relative(repoRoot, dstDir)}`);