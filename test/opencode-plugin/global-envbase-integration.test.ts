/**
 * Integration test for the full options -> anonymizerConfig pipeline.
 *
 * The previous bug surfaced only in the real `plugin.ts` setup path:
 * `normalizePluginOptions` was unconditionally synthesising an `anonymizer`
 * block for users who never set one, which made
 * `anonymizerConfigFromOptions` see `userProvided === true` and fall back to
 * the project directory instead of `~/.config/opencode`.
 *
 * These tests drive both helpers through the same sequence the plugin does
 * and assert the resolved `secrets.envBaseDirectory` ends up where the docs
 * claim.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anonymizerConfigFromOptions,
  normalizePluginOptions,
  opencodeConfigDirectory,
} from "../../src/opencode-plugin/v2/options.js";
import type { RehydraPluginOptions } from "../../src/opencode-plugin/types.js";

describe("integration: full normalize -> resolve pipeline", () => {
  const ocDir = join(tmpdir(), "integ-home", ".config", "opencode");
  const projectDir = join(tmpdir(), "work", "repo");

  function resolve(
    raw: unknown,
    env = Object.assign(Object.create(null), {
      HOME: join(tmpdir(), "integ-home"),
    }) as NodeJS.ProcessEnv,
  ) {
    const normalized: RehydraPluginOptions = normalizePluginOptions(
      raw,
      projectDir,
    );
    return anonymizerConfigFromOptions(normalized, projectDir, env);
  }

  it("uses ~/.config/opencode when the user passes only envFiles", () => {
    const config = resolve({ envFiles: ["**/.env*"] });
    expect(config.secrets?.envBaseDirectory).toBe(ocDir);
  });

  it("uses ~/.config/opencode when the user passes nothing at all", () => {
    const config = resolve({});
    expect(config.secrets?.envBaseDirectory).toBe(ocDir);
  });

  it("preserves the project directory when the user sets anonymizer.secrets.envBaseDirectory", () => {
    const explicit = join(tmpdir(), "explicit");
    const config = resolve({
      anonymizer: { secrets: { envBaseDirectory: explicit } },
    });
    expect(config.secrets?.envBaseDirectory).toBe(explicit);
  });

  it("uses the project directory when the user sets anonymizer without envBaseDirectory", () => {
    // Opting into the advanced config block is treated as "I want full
    // control" — the project directory is the safe default; users override
    // it explicitly via `anonymizer.secrets.envBaseDirectory`.
    const config = resolve({
      anonymizer: { secrets: { envFiles: ["**/.env*"] } },
    });
    expect(config.secrets?.envBaseDirectory).toBe(projectDir);
  });

  it("falls back to the project directory when the OpenCode config dir cannot be resolved", () => {
    // The default `process.env` is still used unless we explicitly hide it.
    // Force an empty environment AND stub homedir so neither HOME, nor
    // USERPROFILE, nor os.homedir() produce a candidate.
    const emptyEnv = Object.create(null) as NodeJS.ProcessEnv;
    const config = anonymizerConfigFromOptions(
      normalizePluginOptions({ envFiles: ["**/.env*"] }, projectDir),
      projectDir,
      emptyEnv,
      () => "",
    );
    expect(config.secrets?.envBaseDirectory).toBe(projectDir);
  });

  it("skips an empty HOME and falls through to the next candidate", () => {
    const config = anonymizerConfigFromOptions(
      normalizePluginOptions({ envFiles: ["**/.env*"] }, projectDir),
      projectDir,
      Object.assign(Object.create(null), {
        HOME: "   ",
        USERPROFILE: join(tmpdir(), "integ-home2"),
      }) as NodeJS.ProcessEnv,
    );
    // Whichever candidate the function uses, the resolved path must reflect
    // the home from this stub environment and not leak `process.env`.
    expect(config.secrets?.envBaseDirectory).toBe(
      join(tmpdir(), "integ-home2", ".config", "opencode"),
    );
  });

  it("opencodeConfigDirectory matches the pipeline result", () => {
    const dir = opencodeConfigDirectory({
      HOME: join(tmpdir(), "integ-home"),
    } as NodeJS.ProcessEnv);
    expect(dir).toBe(ocDir);
  });
});