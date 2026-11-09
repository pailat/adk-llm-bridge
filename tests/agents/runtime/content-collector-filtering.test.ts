import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import { Language, Outcome, type Part } from "@google/genai";
import {
  collectContents,
  flattenContentsToPrompt,
  safeCollectContents,
} from "../../../src/agents/runtime/content-collector.js";

const ctx = (o: Record<string, unknown>) => o as unknown as InvocationContext;
const ev = (
  author: string,
  parts: Part[],
  extra: Record<string, unknown> = {},
) => ({
  author,
  content: { role: author === "user" ? "user" : "model", parts },
  ...extra,
});

describe("collectContents", () => {
  test("returns empty list when the context has no session events", () => {
    expect(collectContents(ctx({}))).toEqual([]);
    expect(collectContents(ctx({ session: {} }))).toEqual([]);
  });

  test("skips null, partial, empty, invisible, thought-only and other-branch events", () => {
    const out = collectContents(
      ctx({
        agent: { name: "me" },
        branch: "root.a",
        session: {
          events: [
            null,
            ev("me", [{ text: "partial" }], { partial: true }),
            { author: "me" },
            ev("me", []),
            ev("me", [{ thought: true }]),
            ev("me", [{ thought: true, text: "private reasoning" }]),
            ev("me", [{ text: "other" }], { branch: "root.b" }),
            ev("me", [{ text: "parent" }], { branch: "root" }),
          ],
        },
      }),
    );
    expect(out).toEqual([{ role: "model", parts: [{ text: "parent" }] }]);
  });

  test("rewrites foreign agent events into user-role markers and drops responses", () => {
    const out = collectContents(
      ctx({
        agent: { name: "me" },
        session: {
          events: [
            ev("other", [
              { thought: true, text: "hidden" },
              { text: "hi" },
              { functionCall: { name: "t", args: { x: 1 } } },
              { functionCall: {} },
              { functionResponse: { name: "t", response: {} } },
            ]),
          ],
        },
      }),
    );
    expect(out).toEqual([
      {
        role: "user",
        parts: [
          { text: "[other said: hi]" },
          { text: '[other called tool t with parameters {"x":1}]' },
          { text: "[other called tool <unknown> with parameters {}]" },
        ],
      },
    ]);
  });

  test("moves an async function response next to its call and appends userContent", () => {
    const userContent = { role: "user", parts: [{ text: "go" }] };
    const out = collectContents(
      ctx({
        userContent,
        session: {
          events: [
            ev("me", [{ functionCall: { id: "c1", name: "f" } }]),
            ev("me", [{ text: "between" }]),
            ev("user", [
              { functionResponse: { id: "c1", name: "f", response: {} } },
            ]),
          ],
        },
      }),
    );
    expect(out.map((c) => Object.keys(c.parts?.[0] ?? {})[0])).toEqual([
      "functionCall",
      "functionResponse",
      "text",
      "text",
    ]);
    expect(out[3]).toBe(userContent);
  });
});

describe("flattenContentsToPrompt", () => {
  test("renders every part kind as a deterministic marker and skips empty turns", () => {
    const circular: Record<string, unknown> = {};
    circular.s = circular;
    const prompt = flattenContentsToPrompt([
      { role: "user", parts: [{ thought: true, text: "x" }] },
      {
        role: "user",
        parts: [
          { text: "hello" },
          { inlineData: { mimeType: "image/png" } },
          { inlineData: { mimeType: "audio/wav" } },
          { inlineData: { mimeType: "video/mp4" } },
          { inlineData: {} },
          { fileData: { fileUri: "gs://b/f", mimeType: "text/plain" } },
          { fileData: {} },
        ],
      },
      {
        role: "model",
        parts: [
          { functionCall: { name: "f", args: { a: 1 } } },
          { functionCall: {} },
          { functionResponse: { name: "f", response: circular } },
          { functionResponse: {} },
          { executableCode: { language: Language.PYTHON, code: "1" } },
          { executableCode: {} },
          { codeExecutionResult: { outcome: Outcome.OUTCOME_OK, output: "o" } },
          { codeExecutionResult: {} },
          {},
        ],
      },
    ]);
    expect(prompt).toBe(
      [
        "user:",
        "hello",
        "[image: image/png]",
        "[audio: audio/wav]",
        "[video: video/mp4]",
        "[document: application/octet-stream]",
        "[file: gs://b/f (text/plain)]",
        "[file: <unknown> (application/octet-stream)]",
        "",
        "assistant:",
        '[tool_call f({"a":1})]',
        "[tool_call <unknown>({})]",
        "[tool_result f: {}]",
        "[tool_result <unknown>: {}]",
        "[code (PYTHON): 1]",
        "[code (PLAINTEXT): ]",
        "[exec OUTCOME_OK: o]",
        "[exec OUTCOME_UNSPECIFIED: ]",
        "[unsupported-part]",
      ].join("\n"),
    );
  });
});

describe("safeCollectContents", () => {
  test("returns an empty list when collection throws", () => {
    const bad = {
      session: {
        get events(): never {
          throw new Error("boom");
        },
      },
    };
    expect(safeCollectContents(bad as unknown as InvocationContext)).toEqual(
      [],
    );
  });
});
