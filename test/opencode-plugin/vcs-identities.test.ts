import { describe, expect, it } from "vitest";
import { createRehydraPlugin } from "../../src/opencode-plugin/plugin.js";
import { vcsCommandTypes } from "../../src/opencode-plugin/vcs-command.js";
import { githubUsernameRecognizer } from "../../src/opencode-plugin/github-username.js";
import { gitIdentityRecognizer } from "../../src/opencode-plugin/git-identity.js";
import type { RehydraPluginOptions } from "../../src/opencode-plugin/types.js";
import {
  createMockV2Context,
  sessionHandler,
  toolHandler,
  type MockHookHandler,
} from "./v2-test-helpers.js";

async function scrub(
  command: string,
  text: string,
  options: RehydraPluginOptions = {},
): Promise<{ text: string; context: MockHookHandler; toolBefore: MockHookHandler }> {
  const mock = createMockV2Context();
  await createRehydraPlugin({ vcsIdentities: true, ...options }).setup(mock.ctx);
  const context = sessionHandler(mock, "context");
  const toolBefore = toolHandler(mock, "execute.before");

  const part = {
    type: "tool",
    state: { status: "completed", input: { command }, output: text },
  };
  const output = {
    messages: [
      { info: { sessionID: "vcs-test", role: "assistant" }, parts: [part] },
    ],
  };
  await context({
    sessionID: "vcs-test",
    system: [],
    messages: output.messages,
  });
  return { text: part.state.output, context, toolBefore };
}

describe("VCS command context", () => {
  it.each(['git -C "/tmp/my repo" log -1', "git --no-pager show", "GIT_PAGER=cat git blame file", "/usr/bin/git --git-dir=.git log"])("recognizes %s", (cmd) => {
    expect(vcsCommandTypes(cmd)).toEqual(new Set(["git"]));
  });
  it.each(["gh --repo org/repo pr view", "gh -R org/repo api repos/org/repo/pulls"])("recognizes %s", (cmd) => {
    expect(vcsCommandTypes(cmd)).toEqual(new Set(["github"]));
  });
  it.each(['echo "git log"', "printf 'gh pr view'", "cat log.txt", "node -e 'git show'", "git status"])("does not infer VCS context from %s", (cmd) => {
    expect(vcsCommandTypes(cmd).size).toBe(0);
  });
  it("recognizes separate commands", () => {
    expect(vcsCommandTypes("git log\ngh pr view")).toEqual(new Set(["git", "github"]));
  });
});

it("does not replace JSON keys or npm scopes that equal a known login", () => {
  const text = '{"id":1,"login":"id"}\n@id asked about @id/package';
  const spans = githubUsernameRecognizer.find(text);
  expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["id", "id"]);
  expect(spans[0]!.start).toBe(text.indexOf('"id"', 10) + 1);
  expect(spans[1]!.start).toBe(text.indexOf("@id") + 1);
});

it("extracts names from raw git headers without swallowing email or timestamp", () => {
  const text = "author Zoë Example <zoe@example.com> 1720000000 +0000\ncommitter Other Name <other@example.com> 1720000000 +0000";
  expect(gitIdentityRecognizer.find(text).map((s) => s.text)).toEqual(["Zoë Example", "Other Name"]);
});

it("honors disabled identity types", async () => {
  const input = "author:\talice-dev\nAuthor: Alice Developer <alice@example.com>";
  const result = await scrub("gh pr view; git log", input, { disableTypes: ["PERSON", "GITHUB_USERNAME"] });
  expect(result.text).toContain("alice-dev");
  expect(result.text).toContain("Alice Developer");
  expect(result.text).not.toContain("alice@example.com");
});

it("preserves secret detection when the default disabled-types list is cleared", async () => {
  const result = await scrub("gh pr view", "author:\talice-dev\nsecret-value-here", { disableTypes: [], redactValues: ["secret-value-here"] });
  expect(result.text).not.toContain("secret-value-here");
  expect(result.text).not.toContain("alice-dev");
});

it("keeps identities stable across history transforms and restores tool arguments", async () => {
  const input = "Author: Zoë Example <zoe@example.com>";
  const { text, context, toolBefore } = await scrub("git -C /tmp/repo log", input);

  const part = { type: "tool", state: { status: "completed", input: { command: "git show" }, output: input } };
  const output = { messages: [{ info: { sessionID: "vcs-test", role: "assistant" }, parts: [part] }] };
  await context({ sessionID: "vcs-test", system: [], messages: output.messages });
  expect(part.state.output).toBe(text);

  const event = { tool: "bash", sessionID: "vcs-test", input: { command: text } };
  await toolBefore(event);
  expect((event.input as { command: string }).command).toBe(input);
});

it.each([undefined, { open: "[[", close: "]]", keyword: "PRIVATE" }])("does not anonymize an existing identity tag again: %j", async (tagFormat) => {
  const input = "Author: Alice Developer <alice@example.com>";
  const { text, context, toolBefore } = await scrub("git log", input, { tagFormat });

  const part = { type: "tool", state: { status: "completed", input: { command: "git log" }, output: text } };
  const output = { messages: [{ info: { sessionID: "vcs-test", role: "assistant" }, parts: [part] }] };
  await context({ sessionID: "vcs-test", system: [], messages: output.messages });
  expect(part.state.output).toBe(text);

  const event = { tool: "bash", sessionID: "vcs-test", input: { command: part.state.output } };
  await toolBefore(event);
  expect((event.input as { command: string }).command).toBe(input);
});
