/**
 * Tests for `rewriteSseBody`.
 *
 * The helper rewrites only the `data:` lines of a complete SSE body while
 * preserving `event:` / `id:` / comment lines and the blank-line frame
 * boundaries. Failures fall back to the original body.
 */

import { describe, expect, it } from "vitest";
import {
  SseStreamRewriter,
  createSseTailState,
  rewriteSseBody,
} from "../../src/opencode-plugin/v2/sse.js";

const SECRET_TAG = '<PII type="ENV_VAR_SECRET" id="1"/>';
const EMAIL_TAG = '<PII type="EMAIL" id="2"/>';

/** Builds a rehydrate stub that replaces known tags with known values. */
function rehydrateWith(map: Record<string, string>) {
  return async (input: string): Promise<string> => {
    let output = input;
    for (const [tag, value] of Object.entries(map)) {
      output = output.split(tag).join(value);
    }
    return output;
  };
}

describe("rewriteSseBody", () => {
  it("rewrites a PII tag in a single frame and preserves the frame structure", async () => {
    const result = await rewriteSseBody(
      `event: message\nid: 7\ndata: key=${SECRET_TAG}\n\n`,
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.body).toBe("event: message\nid: 7\ndata: key=sk-test\n\n");
  });

  it("processes every frame and leaves non-PII frames untouched", async () => {
    const body = `event: message\nid: 1\ndata: key=${SECRET_TAG}\n\ndata: [DONE]\n\n`;
    const result = await rewriteSseBody(
      body,
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.body).toBe(
      "event: message\nid: 1\ndata: key=sk-test\n\ndata: [DONE]\n\n",
    );
  });

  it("passes a body with no PII tags through unchanged", async () => {
    const body =
      "event: message\nid: 1\ndata: plain text\n\nid: 2\ndata: [DONE]\n\n";
    const result = await rewriteSseBody(
      body,
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );

    expect(result.rewrote).toBe(false);
    expect(result.body).toBe(body);
  });

  it("rewrites multiple PII tags within one frame", async () => {
    const result = await rewriteSseBody(
      `data: first=${SECRET_TAG} second=${EMAIL_TAG}`,
      rehydrateWith({
        [SECRET_TAG]: "sk-test",
        [EMAIL_TAG]: "user@example.com",
      }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.body).toBe(
      "data: first=sk-test second=user@example.com",
    );
  });

  it("preserves the `data:` prefix spacing", async () => {
    const result = await rewriteSseBody(
      `data:${SECRET_TAG}\n\ndata: ${SECRET_TAG}`,
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.body).toBe("data:sk-test\n\ndata: sk-test");
  });

  it("returns the original body when rehydrate throws", async () => {
    const body = `data: key=${SECRET_TAG}\n\n`;
    const result = await rewriteSseBody(body, async () => {
      throw new Error("rehydrate failed");
    });

    expect(result.rewrote).toBe(false);
    expect(result.body).toBe(body);
  });

  it("reports the failure reason when rehydrate throws", async () => {
    const body = `data: key=${SECRET_TAG}\n\n`;
    const result = await rewriteSseBody(body, async () => {
      throw new Error("boom");
    });

    expect(result.error).toBe("boom");
    expect(result.mode).toBe("passthrough");
  });

  it("restores a JSON data line with special characters as valid JSON", async () => {
    const value = 'he said "hi", path C:\\tmp,\nnewline café ☕ 中文';
    const payload = JSON.stringify({ chunk: `key=${SECRET_TAG}` });
    const result = await rewriteSseBody(
      `data: ${payload}\n\n`,
      rehydrateWith({ [SECRET_TAG]: value }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.mode).toBe("json");
    const restoredPayload = result.body.split("\n")[0]!.slice("data: ".length);
    expect(JSON.parse(restoredPayload)).toEqual({ chunk: `key=${value}` });
  });

  it("leaves a JSON data line without tags byte-for-byte unchanged", async () => {
    const payload = '{ "a": 1, "b": [2, 3] }';
    const result = await rewriteSseBody(
      `data: ${payload}\n\n`,
      rehydrateWith({}),
    );

    expect(result.rewrote).toBe(false);
    expect(result.mode).toBe("passthrough");
    expect(result.body).toBe(`data: ${payload}\n\n`);
  });

  it("holds a PII tag split across chunks until the frame completes", async () => {
    const rewriter = new SseStreamRewriter(
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );
    const encoder = new TextEncoder();
    const full = `event: message\ndata: key=${SECRET_TAG}\n\n`;
    const splitAt = full.indexOf(SECRET_TAG) + 3;

    const first = await rewriter.push(encoder.encode(full.slice(0, splitAt)));
    const second = await rewriter.push(encoder.encode(full.slice(splitAt)));
    const tail = await rewriter.flush();

    expect(first).toBe("");
    expect(second + tail).toBe("event: message\ndata: key=sk-test\n\n");
  });

  it("flushes an unterminated trailing frame at end of stream", async () => {
    const rewriter = new SseStreamRewriter(
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );
    const encoder = new TextEncoder();

    const pushed = await rewriter.push(
      encoder.encode(`data: key=${SECRET_TAG}`),
    );
    const tail = await rewriter.flush();

    expect(pushed).toBe("");
    expect(tail).toBe("data: key=sk-test");
  });

  it("flushes a final frame that has no blank-line terminator", async () => {
    // The implementation processes the trailing frame but does not synthesise a
    // `\n\n` terminator it was not given.
    const result = await rewriteSseBody(
      `data: key=${SECRET_TAG}`,
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.body).toBe("data: key=sk-test");
  });

  it("rewrites a CRLF-delimited body and preserves the CRLF separators", async () => {
    const body = `event: message\r\nid: 7\r\ndata: key=${SECRET_TAG}\r\n\r\n`;
    const result = await rewriteSseBody(
      body,
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.body).toBe(
      "event: message\r\nid: 7\r\ndata: key=sk-test\r\n\r\n",
    );
  });

  it("handles mixed LF and CRLF frame separators", async () => {
    const body = `data: ${SECRET_TAG}\n\ndata: ${EMAIL_TAG}\r\n\r\n`;
    const result = await rewriteSseBody(
      body,
      rehydrateWith({
        [SECRET_TAG]: "sk-test",
        [EMAIL_TAG]: "user@example.com",
      }),
    );

    expect(result.rewrote).toBe(true);
    expect(result.body).toBe(
      "data: sk-test\n\ndata: user@example.com\r\n\r\n",
    );
  });

  it("restores a tag split across plain-text SSE events", async () => {
    const rehydrate = rehydrateWith({ [SECRET_TAG]: "sk-test" });
    const head = SECRET_TAG.slice(0, 3);
    const rest = SECRET_TAG.slice(3);
    const state = createSseTailState();

    const first = await rewriteSseBody(
      `data: before ${head}\n\n`,
      rehydrate,
      state,
    );
    const second = await rewriteSseBody(
      `data: ${rest} after\n\n`,
      rehydrate,
      state,
    );

    expect(first.rewrote).toBe(true);
    expect(second.body).toBe("data: sk-test after\n\n");
    expect(first.body).toBe("data: before \n\n");
  });

  it("restores a tag split across JSON delta SSE events", async () => {
    const rehydrate = rehydrateWith({ [SECRET_TAG]: "sk-test" });
    const head = SECRET_TAG.slice(0, 3);
    const rest = SECRET_TAG.slice(3);
    const state = createSseTailState();

    const first = await rewriteSseBody(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `hi ${head}` } }] })}\n\n`,
      rehydrate,
      state,
    );
    const second = await rewriteSseBody(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `${rest} bye` } }] })}\n\n`,
      rehydrate,
      state,
    );

    const content = (body: string): string => {
      const payload = body.slice("data: ".length).split("\n")[0]!;
      const parsed = JSON.parse(payload) as {
        choices: { delta: { content: string } }[];
      };
      return parsed.choices[0]!.delta.content;
    };
    expect(content(first.body) + content(second.body)).toBe("hi sk-test bye");
  });
});

describe("SseStreamRewriter", () => {
  it("holds a PII tag split across chunks until the frame completes", async () => {
    const rewriter = new SseStreamRewriter(
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );
    const encoder = new TextEncoder();
    const full = `event: message\ndata: key=${SECRET_TAG}\n\n`;
    const splitAt = full.indexOf(SECRET_TAG) + 3;

    const first = await rewriter.push(encoder.encode(full.slice(0, splitAt)));
    const second = await rewriter.push(encoder.encode(full.slice(splitAt)));
    const tail = await rewriter.flush();

    expect(first).toBe("");
    expect(second + tail).toBe("event: message\ndata: key=sk-test\n\n");
  });

  it("rewrites a CRLF stream and preserves the separators", async () => {
    const rewriter = new SseStreamRewriter(
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );
    const encoder = new TextEncoder();
    const full = `event: message\r\ndata: key=${SECRET_TAG}\r\n\r\n`;

    const pushed = await rewriter.push(encoder.encode(full));
    const tail = await rewriter.flush();

    expect(pushed + tail).toBe(
      "event: message\r\ndata: key=sk-test\r\n\r\n",
    );
  });

  it("restores a tag split across SSE events", async () => {
    const rewriter = new SseStreamRewriter(
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );
    const encoder = new TextEncoder();
    const head = SECRET_TAG.slice(0, 3);
    const rest = SECRET_TAG.slice(3);

    const first = await rewriter.push(encoder.encode(`data: before ${head}\n\n`));
    const second = await rewriter.push(encoder.encode(`data: ${rest} after\n\n`));
    const tail = await rewriter.flush();

    expect(first + second + tail).toBe(
      "data: before \n\ndata: sk-test after\n\n",
    );
  });

  it("restores a tag split across JSON delta SSE events", async () => {
    const rewriter = new SseStreamRewriter(
      rehydrateWith({ [SECRET_TAG]: "sk-test" }),
    );
    const encoder = new TextEncoder();
    const head = SECRET_TAG.slice(0, 3);
    const rest = SECRET_TAG.slice(3);
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: `hi ${head}` } }] })}\n\n`;
    const second = `data: ${JSON.stringify({ choices: [{ delta: { content: `${rest} bye` } }] })}\n\n`;

    const out1 = await rewriter.push(encoder.encode(first));
    const out2 = await rewriter.push(encoder.encode(second));
    const tail = await rewriter.flush();

    const content = (body: string): string => {
      const payload = body.slice("data: ".length).split("\n")[0]!;
      const parsed = JSON.parse(payload) as {
        choices: { delta: { content: string } }[];
      };
      return parsed.choices[0]!.delta.content;
    };
    expect(content(out1) + content(out2 + tail)).toBe("hi sk-test bye");
  });
});
