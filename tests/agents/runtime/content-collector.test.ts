import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import {
  collectContents,
  flattenContentsToPrompt,
} from "../../../src/agents/runtime/content-collector.js";

type EventLike = {
  author?: string;
  invocationId?: string;
  branch?: string;
  partial?: boolean;
  content?: Content;
};

function makeContext(opts: {
  agentName?: string;
  invocationId?: string;
  branch?: string;
  events?: EventLike[];
  userContent?: Content;
}): InvocationContext {
  return {
    invocationId: opts.invocationId,
    agent: opts.agentName ? { name: opts.agentName } : undefined,
    branch: opts.branch,
    session: { events: opts.events ?? [] },
    userContent: opts.userContent,
  } as unknown as InvocationContext;
}

describe("collectContents / flattenContentsToPrompt", () => {
  test("empty session with userContent text", () => {
    const ctx = makeContext({
      userContent: { role: "user", parts: [{ text: "hi" }] },
    });
    const contents = collectContents(ctx);
    expect(contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(flattenContentsToPrompt(contents)).toBe("user:\nhi");
  });

  test("multi-turn alternating user/model events", () => {
    const ctx = makeContext({
      agentName: "alice",
      events: [
        {
          author: "user",
          content: { role: "user", parts: [{ text: "hi" }] },
        },
        {
          author: "alice",
          content: { role: "model", parts: [{ text: "hello" }] },
        },
      ],
    });
    const contents = collectContents(ctx);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
    expect(flattenContentsToPrompt(contents)).toBe(
      "user:\nhi\n\nassistant:\nhello",
    );
  });

  test("foreign-agent text event is rewritten under user role", () => {
    const ctx = makeContext({
      agentName: "main",
      events: [
        {
          author: "billing-bot",
          content: { role: "model", parts: [{ text: "refund issued" }] },
        },
      ],
    });
    const rendered = flattenContentsToPrompt(collectContents(ctx));
    expect(rendered).toContain("user:");
    expect(rendered).toContain("[billing-bot said: refund issued]");
  });

  test("foreign-agent functionCall event is rewritten as text marker", () => {
    const ctx = makeContext({
      agentName: "main",
      events: [
        {
          author: "billing-bot",
          content: {
            role: "model",
            parts: [{ functionCall: { name: "refund", args: { amount: 50 } } }],
          },
        },
      ],
    });
    const rendered = flattenContentsToPrompt(collectContents(ctx));
    expect(rendered).toContain(
      '[billing-bot called tool refund with parameters {"amount":50}]',
    );
  });

  test("branch filtering keeps ancestor branches, excludes siblings", () => {
    const ctx = makeContext({
      agentName: "child",
      branch: "root.child",
      events: [
        {
          author: "user",
          branch: "root",
          content: { role: "user", parts: [{ text: "keep" }] },
        },
        {
          author: "user",
          branch: "root.sibling",
          content: { role: "user", parts: [{ text: "drop" }] },
        },
      ],
    });
    const rendered = flattenContentsToPrompt(collectContents(ctx));
    expect(rendered).toContain("keep");
    expect(rendered).not.toContain("drop");
  });

  test("inlineData image part flattens to image marker", () => {
    const ctx = makeContext({
      agentName: "main",
      events: [
        {
          author: "user",
          content: {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: "base64..." } },
            ],
          },
        },
      ],
    });
    const rendered = flattenContentsToPrompt(collectContents(ctx));
    expect(rendered).toContain("[image: image/png]");
  });

  test("functionCall and functionResponse split by another event are reordered", () => {
    const ctx = makeContext({
      agentName: "main",
      events: [
        {
          author: "main",
          content: {
            role: "model",
            parts: [{ functionCall: { id: "c1", name: "lookup", args: {} } }],
          },
        },
        {
          author: "user",
          content: { role: "user", parts: [{ text: "interleaved" }] },
        },
        {
          author: "user",
          content: {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "c1",
                  name: "lookup",
                  response: { ok: true },
                },
              },
            ],
          },
        },
      ],
    });
    const contents = collectContents(ctx);
    // Expect order: functionCall, functionResponse, interleaved-text.
    const firstParts = contents[0].parts ?? [];
    const secondParts = contents[1].parts ?? [];
    const thirdParts = contents[2].parts ?? [];
    expect(firstParts[0]?.functionCall?.id).toBe("c1");
    expect(secondParts[0]?.functionResponse?.id).toBe("c1");
    expect(thirdParts[0]?.text).toBe("interleaved");
  });

  test("thought parts are dropped from the flattened prompt", () => {
    const ctx = makeContext({
      agentName: "main",
      events: [
        {
          author: "main",
          content: {
            role: "model",
            parts: [
              { text: "visible answer" },
              { text: "secret reasoning", thought: true },
            ],
          },
        },
      ],
    });
    const rendered = flattenContentsToPrompt(collectContents(ctx));
    expect(rendered).toContain("visible answer");
    expect(rendered).not.toContain("secret reasoning");
  });

  test("flattenContentsToPrompt is deterministic across repeated calls", () => {
    const ctx = makeContext({
      agentName: "main",
      events: [
        {
          author: "user",
          content: { role: "user", parts: [{ text: "one" }] },
        },
        {
          author: "main",
          content: { role: "model", parts: [{ text: "two" }] },
        },
        {
          author: "user",
          content: {
            role: "user",
            parts: [
              { functionResponse: { id: "x", name: "t", response: { a: 1 } } },
            ],
          },
        },
      ],
      userContent: { role: "user", parts: [{ text: "three" }] },
    });
    const first = flattenContentsToPrompt(collectContents(ctx));
    const second = flattenContentsToPrompt(collectContents(ctx));
    expect(first).toBe(second);
  });
});

describe("thought-only events", () => {
  test("an event with only thought text is not collected", () => {
    const ctx = makeContext({
      agentName: "alice",
      events: [
        { author: "user", content: { role: "user", parts: [{ text: "hi" }] } },
        {
          author: "alice",
          content: {
            role: "model",
            parts: [{ text: "Let me think.", thought: true }],
          },
        },
      ],
    });
    expect(collectContents(ctx)).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
    ]);
  });

  test("an event with thought text and an answer is still collected", () => {
    const ctx = makeContext({
      agentName: "alice",
      events: [
        { author: "user", content: { role: "user", parts: [{ text: "hi" }] } },
        {
          author: "alice",
          content: {
            role: "model",
            parts: [{ text: "Hmm.", thought: true }, { text: "hello" }],
          },
        },
      ],
    });
    expect(collectContents(ctx)).toHaveLength(2);
    expect(flattenContentsToPrompt(collectContents(ctx))).toBe(
      "user:\nhi\n\nassistant:\nhello",
    );
  });
});

describe("the current user turn is collected once", () => {
  const go = (): Content => ({ role: "user", parts: [{ text: "go" }] });

  test("a userContent equal to the session's last user event (another object) is not added again", () => {
    const ctx = makeContext({
      agentName: "alice",
      invocationId: "inv-1",
      events: [{ author: "user", invocationId: "inv-1", content: go() }],
      userContent: go(),
    });
    const prompt = flattenContentsToPrompt(collectContents(ctx));
    expect(prompt).toBe("user:\ngo");
  });

  test("other agents' turns after the user event do not make it count twice", () => {
    const ctx = makeContext({
      agentName: "bob",
      invocationId: "inv-1",
      events: [
        { author: "user", invocationId: "inv-1", content: go() },
        {
          author: "alice",
          content: { role: "model", parts: [{ text: "done" }] },
        },
      ],
      userContent: go(),
    });
    const prompt = flattenContentsToPrompt(collectContents(ctx));
    expect(prompt.match(/\ngo(\n|$)/g)).toHaveLength(1);
  });

  test("a repeated message is kept: an earlier equal turn is history, the last one is the current turn", () => {
    const ctx = makeContext({
      agentName: "alice",
      invocationId: "inv-2",
      events: [
        { author: "user", invocationId: "inv-1", content: go() },
        {
          author: "alice",
          invocationId: "inv-1",
          content: { role: "model", parts: [{ text: "ok" }] },
        },
        { author: "user", invocationId: "inv-2", content: go() },
      ],
      userContent: go(),
    });
    expect(flattenContentsToPrompt(collectContents(ctx))).toBe(
      "user:\ngo\n\nassistant:\nok\n\nuser:\ngo",
    );
  });

  test("a userContent that is not in the session is still added", () => {
    const ctx = makeContext({
      agentName: "alice",
      events: [
        { author: "user", content: go() },
        {
          author: "alice",
          content: { role: "model", parts: [{ text: "ok" }] },
        },
      ],
      userContent: { role: "user", parts: [{ text: "next" }] },
    });
    expect(flattenContentsToPrompt(collectContents(ctx))).toBe(
      "user:\ngo\n\nassistant:\nok\n\nuser:\nnext",
    );
  });

  test("a userContent that differs from the last user event only in a later part is added", () => {
    const ctx = makeContext({
      agentName: "alice",
      invocationId: "inv-1",
      events: [{ author: "user", invocationId: "inv-1", content: go() }],
      userContent: { role: "user", parts: [{ text: "go" }, { text: "now" }] },
    });
    expect(flattenContentsToPrompt(collectContents(ctx))).toBe(
      "user:\ngo\n\nuser:\ngo\nnow",
    );
  });

  test("this agent's tool call and result after the user's message do not make the current turn count again", () => {
    const ctx = makeContext({
      agentName: "alice",
      invocationId: "inv-2",
      events: [
        { author: "user", invocationId: "inv-1", content: go() },
        {
          author: "alice",
          invocationId: "inv-1",
          content: { role: "model", parts: [{ text: "ok" }] },
        },
        { author: "user", invocationId: "inv-2", content: go() },
        {
          author: "alice",
          invocationId: "inv-2",
          content: {
            role: "model",
            parts: [{ functionCall: { id: "call-1", name: "t", args: {} } }],
          },
        },
        {
          author: "alice",
          invocationId: "inv-2",
          content: {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call-1",
                  name: "t",
                  response: { r: 1 },
                },
              },
            ],
          },
        },
      ],
      userContent: go(),
    });
    const prompt = flattenContentsToPrompt(collectContents(ctx));
    expect(prompt).toBe(
      'user:\ngo\n\nassistant:\nok\n\nuser:\ngo\n\nassistant:\n[tool_call t({})]\n\nuser:\n[tool_result t: {"r":1}]',
    );
    expect(prompt.match(/\ngo(\n|$)/g)).toHaveLength(2);
  });

  test("a repeated message that is not in the session is still the current turn", () => {
    const ctx = makeContext({
      agentName: "alice",
      invocationId: "inv-2",
      events: [
        { author: "user", invocationId: "inv-1", content: go() },
        {
          author: "alice",
          invocationId: "inv-1",
          content: { role: "model", parts: [{ text: "ok" }] },
        },
      ],
      userContent: go(),
    });
    expect(flattenContentsToPrompt(collectContents(ctx))).toBe(
      "user:\ngo\n\nassistant:\nok\n\nuser:\ngo",
    );
  });

  test("without an invocation id on both sides the session event is not taken as the current turn", () => {
    const ctx = makeContext({
      agentName: "alice",
      events: [{ author: "user", content: go() }],
      userContent: go(),
    });
    expect(flattenContentsToPrompt(collectContents(ctx))).toBe(
      "user:\ngo\n\nuser:\ngo",
    );
  });

  test("an empty invocation id on both sides is not a match", () => {
    const ctx = makeContext({
      agentName: "alice",
      invocationId: "",
      events: [{ author: "user", invocationId: "", content: go() }],
      userContent: go(),
    });
    expect(flattenContentsToPrompt(collectContents(ctx))).toBe(
      "user:\ngo\n\nuser:\ngo",
    );
  });

  test("a current turn whose parts cannot be serialized is still collected", () => {
    const cyclicTurn = (): Content => {
      const response: Record<string, unknown> = { result: "x" };
      response.self = response;
      return {
        role: "user",
        parts: [{ text: "go" }, { functionResponse: { name: "f", response } }],
      };
    };
    const userContent = cyclicTurn();
    const ctx = makeContext({
      agentName: "alice",
      invocationId: "inv-1",
      events: [
        { author: "user", invocationId: "inv-1", content: cyclicTurn() },
      ],
      userContent,
    });
    const contents = collectContents(ctx);
    expect(contents).toHaveLength(2);
    expect(contents.at(-1)).toBe(userContent);
  });
});
