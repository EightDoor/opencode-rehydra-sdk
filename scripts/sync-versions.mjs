#!/usr/bin/env node
// 把根包版本同步到同版本发布的子包，避免发布时子包版本落后于根包。
// 由根 package.json 的 `version` 生命周期钩子在 `npm version` 之后调用，
// 并把改动的文件加入 git 暂存区，使其进入 npm version 生成的提交。
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 与根包同步版本的子包；新增子包时在此登记
const SUB_PACKAGE_FILES = [
  "packages/opencode-plugin/package.json",
  "packages/pi-extension/package.json",
];

const rootVersion = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version;
if (typeof rootVersion !== "string" || rootVersion === "") {
  throw new Error("根 package.json 缺少 version 字段，无法同步子包版本");
}

const updatedFiles = [];
for (const relativePath of SUB_PACKAGE_FILES) {
  const filePath = path.join(repoRoot, relativePath);
  const raw = await readFile(filePath, "utf8");
  const currentVersion = JSON.parse(raw).version;
  if (currentVersion === rootVersion) {
    console.log(`${relativePath} 已是 ${rootVersion}，跳过`);
    continue;
  }

  // 只改写顶层 version 行，保留原有缩进、字段顺序与结尾换行
  const updated = raw.replace(/^(\s*"version"\s*:\s*")[^"]*(")/mu, `$1${rootVersion}$2`);
  const parsedVersion = JSON.parse(updated).version;
  if (parsedVersion !== rootVersion) {
    throw new Error(`${relativePath} 顶层 version 改写失败，结果仍为 ${parsedVersion}`);
  }

  await writeFile(filePath, updated);
  updatedFiles.push(relativePath);
  console.log(`${relativePath}: ${currentVersion} -> ${rootVersion}`);
}

if (updatedFiles.length === 0) {
  process.exit(0);
}

// 未纳入提交会让发布用的子包版本滞留，因此暂存失败必须显式报错
const { stdout: insideWorkTree } = await run("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: repoRoot,
}).catch(() => ({ stdout: "false" }));
if (insideWorkTree.trim() !== "true") {
  console.log("当前目录不是 git 工作区，跳过暂存；请自行提交上述文件");
  process.exit(0);
}

try {
  await run("git", ["add", "--", ...updatedFiles], { cwd: repoRoot });
  console.log(`已暂存 ${updatedFiles.join(" ")}`);
} catch (error) {
  throw new Error(`git add 失败，子包版本不会被提交：${error.message}`);
}
