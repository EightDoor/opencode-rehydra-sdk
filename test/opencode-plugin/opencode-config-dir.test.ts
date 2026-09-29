import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  anonymizerConfigFromOptions,
  opencodeConfigDirectory,
  shouldUseOpencodeConfigDir,
} from "../../src/opencode-plugin/v2/options.js";

describe("opencodeConfigDirectory", () => {
  it("honours XDG_CONFIG_HOME when set", () => {
    const home = join(tmpdir(), "home");
    const xdg = join(tmpdir(), "xdg");
    const env = { XDG_CONFIG_HOME: xdg, HOME: home } as NodeJS.ProcessEnv;
    const result = opencodeConfigDirectory(env);
    expect(result).toBe(join(xdg, "opencode"));
  });

  it("falls back to $HOME/.config/opencode", () => {
    const home = join(tmpdir(), "home");
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const result = opencodeConfigDirectory(env);
    expect(result).toBe(join(home, ".config", "opencode"));
  });

  it("returns undefined when no usable path exists", () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = opencodeConfigDirectory(env, () => "");
    expect(result).toBeUndefined();
  });
});

describe("shouldUseOpencodeConfigDir", () => {
  const ocDir = join(tmpdir(), "config", "opencode");
  const projectInside = ocDir + sep + "some-project";
  const projectSibling = join(tmpdir(), "projects", "foo");

  it("returns false when the project is the OpenCode config dir itself", () => {
    expect(shouldUseOpencodeConfigDir(ocDir, ocDir)).toBe(false);
  });

  it("returns false when the project is unrelated to the OpenCode config dir", () => {
    expect(shouldUseOpencodeConfigDir(projectSibling, ocDir)).toBe(false);
  });

  it("returns false when paths only share a prefix", () => {
    const lookAlike = ocDir + "-other";
    expect(shouldUseOpencodeConfigDir(lookAlike, ocDir)).toBe(false);
  });

  it("does not require a special branch for unrelated prefixes", () => {
    const oc = join(tmpdir(), "opencode");
    const project = join(tmpdir(), "opencode-fork", "x");
    expect(shouldUseOpencodeConfigDir(project, oc)).toBe(false);
  });
});

describe("anonymizerConfigFromOptions opencode-config-dir fallback", () => {
  const ocDir = join(tmpdir(), "home", ".config", "opencode");
  const projectDir = join(tmpdir(), "work", "repo");

  const env = { HOME: join(tmpdir(), "home") } as NodeJS.ProcessEnv;

  it("uses ~/.config/opencode by default so a single global .env works on every platform", () => {
    const result = anonymizerConfigFromOptions(
      { envFiles: ["**/.env*"] } as never,
      projectDir,
      env,
    );
    expect(result.secrets?.envBaseDirectory).toBe(ocDir);
  });

  it("does not vary by projectDir: the OpenCode config dir wins regardless", () => {
    const nestedProject = ocDir + sep + "sessions" + sep + "session-1";
    const result = anonymizerConfigFromOptions(
      { envFiles: ["**/.env*"] } as never,
      nestedProject,
      env,
    );
    expect(result.secrets?.envBaseDirectory).toBe(ocDir);
  });

  it("honours an explicit envBaseDirectory (project-local discovery)", () => {
    const explicit = join(tmpdir(), "explicit");
    const result = anonymizerConfigFromOptions(
      {
        envFiles: ["**/.env*"],
        anonymizer: { secrets: { envBaseDirectory: explicit } },
      } as never,
      projectDir,
      env,
    );
    expect(result.secrets?.envBaseDirectory).toBe(explicit);
  });

  it("falls back to ctxDirectory when the OpenCode config dir is unresolved", () => {
    const result = anonymizerConfigFromOptions(
      { envFiles: ["**/.env*"] } as never,
      projectDir,
      {} as NodeJS.ProcessEnv,
      () => "",
    );
    expect(result.secrets?.envBaseDirectory).toBe(projectDir);
  });
});