/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import {
  collectContents,
  flattenContentsToPrompt,
} from "../../../src/agents/runtime/content-collector.js";

type EventLike = {
  author?: string;
  branch?: string;
  partial?: boolean;
  content?: Content;
};

function makeContext(opts: {
  agentName?: string;
  branch?: string;
  events?: EventLike[];
  userContent?: Content;
}): InvocationContext {
  return {
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
    expect(flattenContentsToPrompt(contents)).toBe("user:\nhi\n\nassistant:\nhello");
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
      "[billing-bot called tool refund with parameters {\"amount\":50}]",
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
            parts: [{ inlineData: { mimeType: "image/png", data: "base64..." } }],
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
            parts: [{ functionResponse: { id: "x", name: "t", response: { a: 1 } } }],
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
