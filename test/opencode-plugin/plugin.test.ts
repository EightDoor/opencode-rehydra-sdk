/**
 * Tests for the Rehydra OpenCode plugin (Plugin V2 shape).
 *
 * The plugin is created with `createRehydraPlugin()` and started with
 * `plugin.setup(ctx)`. A fake V2 context records the registered
 * `session.hook` / `tool.hook` handlers; the tests invoke those handlers with
 * mock events and verify that:
 * - the `context` hook anonymizes text parts, tool arguments and tool outputs
 *   and injects the rehydra instruction once anything was anonymized
 * - `tool.execute.before` rehydrates PII tags in tool arguments
 * - `tool.execute.after` rehydrates PII tags in completed tool results
 * - `http.response` rehydrates PII tags in the primary answer body
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createRehydraPlugin } from "../../src/opencode-plugin/plugin.js";
import {
  createMockV2Context,
  sessionHandler,
  toolHandler,
  type MockHookHandler,
  type MockV2Context,
} from "./v2-test-helpers.js";

// Helper: create a TextPart-like object
function textPart(
  text: string,
  sessionID = "ses-1",
  messageID = "msg-1",
): Record<string, unknown> {
  return {
    id: `part-${Math.random().toString(36).slice(2, 8)}`,
    sessionID,
    messageID,
    type: "text",
    text,
  };
}

// Helper: create a ToolPart-like object with completed state
function toolPart(
  output: string,
  sessionID = "ses-1",
  messageID = "msg-1",
  command = "echo test",
): Record<string, unknown> {
  return {
    id: `part-${Math.random().toString(36).slice(2, 8)}`,
    sessionID,
    messageID,
    type: "tool",
    callID: `call-${Math.random().toString(36).slice(2, 8)}`,
    tool: "bash",
    state: {
      status: "completed",
      input: { command },
      output,
      title: "bash",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

// Helper: create a non-text part (e.g., FilePart)
function filePart(
  sessionID = "ses-1",
  messageID = "msg-1",
): Record<string, unknown> {
  return {
    id: `part-${Math.random().toString(36).slice(2, 8)}`,
    sessionID,
    messageID,
    type: "file",
    path: "/some/file.ts",
  };
}

// Helper: create a V1-style message (info + parts), which V2 scrub still reads.
function message(
  role: string,
  parts: Record<string, unknown>[],
  sessionID = "ses-1",
): {
  info: { sessionID: string; role: string };
  parts: Record<string, unknown>[];
} {
  return {
    info: {
      sessionID,
      role,
    },
    parts: parts as Array<{
      type: string;
      text?: string;
      state?: { status: string; output?: string };
      [key: string]: unknown;
    }>,
  };
}

// A secret value long enough to trigger detection (>= 8 chars default)
const TEST_SECRET = "sk-proj-abc123xyz789testkey";

describe("OpenCode Plugin", () => {
  let mock: MockV2Context;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: MockHookHandler;
  let toolBefore: MockHookHandler;
  let toolAfter: MockHookHandler;
  let httpResponse: MockHookHandler;

  beforeAll(async () => {
    mock = createMockV2Context();
    const plugin = createRehydraPlugin({
      redactValues: [TEST_SECRET],
    });
    await plugin.setup(mock.ctx);
    context = sessionHandler(mock, "context");
    toolBefore = toolHandler(mock, "execute.before");
    toolAfter = toolHandler(mock, "execute.after");
    httpResponse = sessionHandler(mock, "http.response");
  });

  // Builds a `context` event wrapping the given messages in place.
  function contextEvent(
    sessionID: string,
    messages: unknown[],
  ): { sessionID: string; system: unknown[]; messages: unknown[] } {
    return { sessionID, system: [], messages };
  }

  describe("hooks registration", () => {
    it("registers the request and response session hooks", () => {
      expect([...mock.sessionHooks.map((hook) => hook.name)].sort()).toEqual(
        [
          "compaction",
          "context",
          "experimental.ws.receive",
          "generate",
          "http.response",
          "title",
        ].sort(),
      );
    });

    it("registers the tool execution hooks", () => {
      expect([...mock.toolHooks.map((hook) => hook.name)].sort()).toEqual([
        "execute.after",
        "execute.before",
      ]);
    });
  });

  describe("context hook", () => {
    it.each(["completed", "error", "running"])(
      "scrubs restored tool arguments in %s history",
      async (status) => {
        const original = {
          command: `printf '%s' '${TEST_SECRET}'`,
          nested: [
            { email: "ada@example.com", count: 2, enabled: true, empty: null },
          ],
          "ada@example.com": "a property name",
        };
        const state = {
          status,
          input: original,
          error: `Failed for ada@example.com: ${TEST_SECRET}`,
        };
        const output = {
          messages: [message("assistant", [{ type: "tool", state }])],
        };

        await context(contextEvent("ses-1", output.messages));

        expect(state.input.command).not.toContain(TEST_SECRET);
        expect(state.input.nested[0]!.email).toContain("<PII");
        expect(state.error).not.toContain(TEST_SECRET);
        expect(state.error).not.toContain("ada@example.com");
        expect(state.input.nested[0]).toMatchObject({
          count: 2,
          enabled: true,
          empty: null,
        });
        expect(state.input["ada@example.com"]).toBe("a property name");
        expect(original.command).toContain(TEST_SECRET);
        expect(original.nested[0]!.email).toBe("ada@example.com");

        const once = structuredClone(state.input);
        await context(contextEvent("ses-1", output.messages));
        expect(state.input).toEqual(once);

        const execution = {
          tool: "bash",
          sessionID: "ses-1",
          input: structuredClone(state.input),
        };
        await toolBefore(execution);
        expect(execution.input).toEqual(original);
      },
    );

    it("anonymizes secrets in TextPart", async () => {
      const output = {
        messages: [
          message("user", [textPart(`Use this API key: ${TEST_SECRET}`)]),
        ],
      };

      await context(contextEvent("ses-1", output.messages));

      const text = (output.messages[0]!.parts[0] as { text: string }).text;
      expect(text).not.toContain(TEST_SECRET);
      expect(text).toContain("<PII");
      expect(text).toContain("/>");
    });

    it("anonymizes secrets in ToolPart completed output", async () => {
      const output = {
        messages: [
          message("assistant", [
            toolPart(`Config loaded: API_KEY=${TEST_SECRET}`),
          ]),
        ],
      };

      await context(contextEvent("ses-1", output.messages));

      const state = (
        output.messages[0]!.parts[0] as { state: { output: string } }
      ).state;
      expect(state.output).not.toContain(TEST_SECRET);
      expect(state.output).toContain("<PII");
    });

    it("skips non-text parts", async () => {
      const fp = filePart();
      const output = {
        messages: [message("user", [fp])],
      };

      await context(contextEvent("ses-1", output.messages));

      // FilePart should be unchanged
      expect(output.messages[0]!.parts[0]).toBe(fp);
    });

    it("skips tool parts that are not completed", async () => {
      const tp: Record<string, unknown> = {
        id: "part-1",
        sessionID: "ses-1",
        messageID: "msg-1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "running",
        },
      };

      const output = {
        messages: [message("user", [tp])],
      };

      await context(contextEvent("ses-1", output.messages));

      // Should not throw or modify
      expect((tp.state as { status: string }).status).toBe("running");
    });

    it("does not modify text without secrets", async () => {
      const originalText = "Hello, how can I help you today?";
      const output = {
        messages: [message("user", [textPart(originalText)])],
      };

      await context(contextEvent("ses-1", output.messages));

      const text = (output.messages[0]!.parts[0] as { text: string }).text;
      expect(text).toBe(originalText);
    });

    it("anonymizes GitHub participants only in gh output when enabled", async () => {
      const githubMock = createMockV2Context();
      const githubPlugin = createRehydraPlugin({ vcsIdentities: true });
      await githubPlugin.setup(githubMock.ctx);
      const githubContext = sessionHandler(githubMock, "context");
      const githubToolBefore = toolHandler(githubMock, "execute.before");

      const output = {
        messages: [
          message(
            "assistant",
            [
              toolPart(
                'author:\talice-dev\nreviewers:\toctocat (Approved)\n{"author":{"login":"json-user"}}\n--\n@alice-dev asked @octocat and @json-user to check @rehydra/opencode',
                "ses-github",
                "msg-github",
                "gh pr view 42 --comments",
              ),
            ],
            "ses-github",
          ),
        ],
      };

      await githubContext(contextEvent("ses-github", output.messages));

      const state = (
        output.messages[0]!.parts[0] as { state: { output: string } }
      ).state;
      expect(state.output).not.toContain("alice-dev");
      expect(state.output).not.toContain("octocat");
      expect(state.output).not.toContain("json-user");
      expect(state.output).toContain("@rehydra/opencode");
      expect(state.output.match(/GITHUB_USERNAME/g)).toHaveLength(6);

      const args = {
        tool: "bash",
        sessionID: "ses-github",
        input: { command: `gh pr comment 42 --body '${state.output}'` },
      };
      await githubToolBefore(args);
      const command = (args.input as { command: string }).command;
      expect(command).toContain("@alice-dev");
      expect(command).toContain("@octocat");
      expect(command).toContain("@json-user");
    });

    it("leaves GitHub-like names in unrelated tool output", async () => {
      const githubMock = createMockV2Context();
      const githubPlugin = createRehydraPlugin({ vcsIdentities: true });
      await githubPlugin.setup(githubMock.ctx);
      const githubContext = sessionHandler(githubMock, "context");

      const output = {
        messages: [
          message("assistant", [toolPart("author:\talice-dev\n@alice-dev")]),
        ],
      };

      await githubContext(contextEvent("ses-1", output.messages));

      const state = (
        output.messages[0]!.parts[0] as { state: { output: string } }
      ).state;
      expect(state.output).toContain("alice-dev");
    });

    it("anonymizes identities in git output when enabled", async () => {
      const vcsMock = createMockV2Context();
      const vcsPlugin = createRehydraPlugin({ vcsIdentities: true });
      await vcsPlugin.setup(vcsMock.ctx);
      const vcsContext = sessionHandler(vcsMock, "context");
      const vcsToolBefore = toolHandler(vcsMock, "execute.before");

      const output = {
        messages: [
          message(
            "assistant",
            [
              toolPart(
                "commit abc123\nAuthor: Alice Developer <alice@example.com>\nauthor Bob Builder\nabc123 (Carol Coder 2026-09-03 10:00:00 +0000 1) line\n\n    Pair with Alice Developer and Bob Builder\n",
                "ses-git",
                "msg-git",
                "git log -1",
              ),
            ],
            "ses-git",
          ),
        ],
      };

      await vcsContext(contextEvent("ses-git", output.messages));

      const state = (
        output.messages[0]!.parts[0] as { state: { output: string } }
      ).state;
      expect(state.output).not.toContain("Alice Developer");
      expect(state.output).not.toContain("Bob Builder");
      expect(state.output).not.toContain("Carol Coder");
      expect(state.output).not.toContain("alice@example.com");
      expect(state.output.match(/type="PERSON"/g)).toHaveLength(5);
      expect(state.output).toContain('type="EMAIL"');

      const args = {
        tool: "bash",
        sessionID: "ses-git",
        input: { command: `git show --format='${state.output}'` },
      };
      await vcsToolBefore(args);
      const command = (args.input as { command: string }).command;
      expect(command).toContain("Alice Developer");
      expect(command).toContain("Bob Builder");
      expect(command).toContain("Carol Coder");
      expect(command).toContain("alice@example.com");
    });
  });

  describe("context hook system instruction", () => {
    it("injects rehydra instruction after anonymization", async () => {
      // First, trigger anonymization so hasAnonymized = true
      const msgOutput = {
        messages: [message("user", [textPart(`Key: ${TEST_SECRET}`)])],
      };
      await context(contextEvent("ses-1", msgOutput.messages));

      // Now check the system instruction injection
      const sysOutput = [{ type: "text", text: "You are a helpful assistant." }];
      await context({
        sessionID: "ses-1",
        system: sysOutput,
        messages: [],
      });

      expect(sysOutput).toHaveLength(2);
      const instruction = sysOutput[1] as unknown as { text: string };
      expect(instruction.text).toContain("<rehydra>");
      expect(instruction.text).toContain("PII placeholders");
    });
  });

  describe("tool.execute.before", () => {
    it("rehydrates PII tags in string args", async () => {
      // First, anonymize to build the PII map
      const msgOutput = {
        messages: [message("user", [textPart(`Use key ${TEST_SECRET}`)])],
      };
      await context(contextEvent("ses-1", msgOutput.messages));

      // Extract the PII tag from the anonymized text
      const anonymizedText = (
        msgOutput.messages[0]!.parts[0] as { text: string }
      ).text;
      const tagMatch = anonymizedText.match(/<PII[^/]*\/>/);
      expect(tagMatch).not.toBeNull();
      const piiTag = tagMatch![0]!;

      // Simulate tool args containing the PII tag
      const event = {
        tool: "bash",
        sessionID: "ses-1",
        input: { command: `curl -H "Authorization: Bearer ${piiTag}"` },
      };

      await toolBefore(event);

      const command = (event.input as { command: string }).command;
      expect(command).toContain(TEST_SECRET);
      expect(command).not.toContain("<PII");
    });

    it("rehydrates PII tags in nested object args", async () => {
      // Anonymize first
      const msgOutput = {
        messages: [message("user", [textPart(`Secret: ${TEST_SECRET}`)])],
      };
      await context(contextEvent("ses-1", msgOutput.messages));

      const anonymizedText = (
        msgOutput.messages[0]!.parts[0] as { text: string }
      ).text;
      const tagMatch = anonymizedText.match(/<PII[^/]*\/>/);
      const piiTag = tagMatch![0]!;

      const event = {
        tool: "write",
        sessionID: "ses-1",
        input: {
          config: {
            nested: {
              value: `token=${piiTag}`,
            },
            list: [`item-${piiTag}`],
          },
        },
      };

      await toolBefore(event);

      const args = event.input as {
        config: { nested: { value: string }; list: string[] };
      };
      expect(args.config.nested.value).toContain(TEST_SECRET);
      expect(args.config.list[0]).toContain(TEST_SECRET);
    });

    it("passes through args without PII tags", async () => {
      const event = {
        tool: "bash",
        sessionID: "ses-1",
        input: { command: "ls -la", path: "/home/user" },
      };

      await toolBefore(event);

      expect(event.input).toEqual({ command: "ls -la", path: "/home/user" });
    });
  });

  describe("tool.execute.after", () => {
    it("rehydrates PII tags in tool title", async () => {
      // Anonymize first
      const msgOutput = {
        messages: [message("user", [textPart(`Use key ${TEST_SECRET}`)])],
      };
      await context(contextEvent("ses-1", msgOutput.messages));

      const anonymizedText = (
        msgOutput.messages[0]!.parts[0] as { text: string }
      ).text;
      const tagMatch = anonymizedText.match(/<PII[^/]*\/>/);
      const piiTag = tagMatch![0]!;

      const event = {
        tool: "bash",
        sessionID: "ses-1",
        input: {},
        status: "completed" as const,
        result: {
          title: `$ zwrm secrets set KEY "${piiTag}"`,
          output: "Updated secret KEY (version 1)",
          metadata: {},
        },
      };

      await toolAfter(event);

      const result = event.result as { title: string };
      expect(result.title).toContain(TEST_SECRET);
      expect(result.title).not.toContain("<PII");
    });

    it("rehydrates PII tags in tool output", async () => {
      const msgOutput = {
        messages: [message("user", [textPart(`Key: ${TEST_SECRET}`)])],
      };
      await context(contextEvent("ses-1", msgOutput.messages));

      const anonymizedText = (
        msgOutput.messages[0]!.parts[0] as { text: string }
      ).text;
      const tagMatch = anonymizedText.match(/<PII[^/]*\/>/);
      const piiTag = tagMatch![0]!;

      const event = {
        tool: "bash",
        sessionID: "ses-1",
        input: {},
        status: "completed" as const,
        result: {
          title: "$ cat .env",
          output: `API_KEY=${piiTag}\nDEBUG=true`,
          metadata: {},
        },
      };

      await toolAfter(event);

      const result = event.result as { title: string; output: string };
      expect(result.output).toContain(TEST_SECRET);
      expect(result.output).not.toContain("<PII");
      // title had no PII tags, should be unchanged
      expect(result.title).toBe("$ cat .env");
    });

    it("rehydrates PII tags in MCP CallToolResult shape", async () => {
      // Anonymize first
      const msgOutput = {
        messages: [message("user", [textPart(`Key: ${TEST_SECRET}`)])],
      };
      await context(contextEvent("ses-1", msgOutput.messages));

      const anonymizedText = (
        msgOutput.messages[0]!.parts[0] as { text: string }
      ).text;
      const tagMatch = anonymizedText.match(/<PII[^/]*\/>/);
      const piiTag = tagMatch![0]!;

      // MCP tools pass raw CallToolResult — no title/output fields
      const event = {
        tool: "tavily_search",
        sessionID: "ses-1",
        input: {},
        status: "completed" as const,
        result: {
          content: [
            {
              type: "text",
              text: `Search results for ${piiTag}: found 3 matches`,
            },
          ],
          isError: false,
        },
      };

      await toolAfter(event);

      const text = (event.result as { content: { text: string }[] }).content[0]!
        .text;
      expect(text).toContain(TEST_SECRET);
      expect(text).not.toContain("<PII");
    });

    it("does not throw on MCP output without PII tags", async () => {
      const event = {
        tool: "exa_search",
        sessionID: "ses-1",
        input: {},
        status: "completed" as const,
        result: {
          content: [{ type: "text", text: "No sensitive data here" }],
          isError: false,
        },
      };

      await toolAfter(event);

      const text = (event.result as { content: { text: string }[] }).content[0]!
        .text;
      expect(text).toBe("No sensitive data here");
    });

    it("should not modify output without PII tags", async () => {
      const event = {
        tool: "bash",
        sessionID: "ses-1",
        input: {},
        status: "completed" as const,
        result: {
          title: "$ ls -la",
          output: "total 0\ndrwxr-xr-x 2 user user 64 Jan 1 00:00 .",
          metadata: {},
        },
      };

      await toolAfter(event);

      const result = event.result as { title: string; output: string };
      expect(result.title).toBe("$ ls -la");
      expect(result.output).toBe(
        "total 0\ndrwxr-xr-x 2 user user 64 Jan 1 00:00 .",
      );
    });
  });

  describe("http.response", () => {
    it("rehydrates PII tags in a JSON response body", async () => {
      // Anonymize first to build PII map
      const msgOutput = {
        messages: [message("user", [textPart(`API key: ${TEST_SECRET}`)])],
      };
      await context(contextEvent("ses-1", msgOutput.messages));

      const anonymizedText = (
        msgOutput.messages[0]!.parts[0] as { text: string }
      ).text;
      const tagMatch = anonymizedText.match(/<PII[^/]*\/>/);
      const piiTag = tagMatch![0]!;

      const event = {
        sessionID: "ses-1",
        kind: "primary" as const,
        response: new Response(
          JSON.stringify({
            choices: [{ message: { content: `I found the key: ${piiTag}` } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      };

      await httpResponse(event);

      const body = (await event.response.json()) as {
        choices: { message: { content: string } }[];
      };
      expect(body.choices[0]!.message.content).toContain(TEST_SECRET);
      expect(body.choices[0]!.message.content).not.toContain("<PII");
    });

    it("leaves a JSON response without PII tags unchanged", async () => {
      const payload = JSON.stringify({
        choices: [{ message: { content: "regular answer" } }],
      });
      const event = {
        sessionID: "ses-1",
        kind: "primary" as const,
        response: new Response(payload, {
          headers: { "content-type": "application/json" },
        }),
      };

      await httpResponse(event);

      expect(await event.response.text()).toBe(payload);
    });
  });

  describe("session management", () => {
    it("should maintain separate sessions per sessionID", async () => {
      // Create a fresh plugin to avoid cross-contamination from earlier tests
      const freshMock = createMockV2Context();
      const freshPlugin = createRehydraPlugin({
        redactValues: [TEST_SECRET],
      });
      await freshPlugin.setup(freshMock.ctx);
      const freshContext = sessionHandler(freshMock, "context");
      const freshToolBefore = toolHandler(freshMock, "execute.before");

      // Anonymize in session A
      const outputA = {
        messages: [
          message("user", [textPart(`Key: ${TEST_SECRET}`)], "ses-A"),
        ],
      };
      await freshContext(contextEvent("ses-A", outputA.messages));

      const tagA = (
        outputA.messages[0]!.parts[0] as { text: string }
      ).text.match(/<PII[^/]*\/>/)![0]!;

      // Rehydrate in session A — should work
      const eventA = {
        tool: "bash",
        sessionID: "ses-A",
        input: { cmd: tagA },
      };
      await freshToolBefore(eventA);
      expect((eventA.input as { cmd: string }).cmd).toContain(TEST_SECRET);

      // Rehydrate in session B — no PII map, so the tag must pass through
      // unchanged (Plugin V2 hooks never throw; failures are logged/swallowed).
      const eventB = {
        tool: "bash",
        sessionID: "ses-B",
        input: { cmd: tagA },
      };
      await freshToolBefore(eventB);
      expect((eventB.input as { cmd: string }).cmd).toBe(tagA);
    });
  });
});
