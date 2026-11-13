import { describe, expect, test } from "bun:test";
import { type Content, Language, Outcome } from "@google/genai";
import { contentsToSdkMessages } from "../../../src/agents/driver/claude-message-mapper.js";

const texts = (contents: Content[]) =>
  contentsToSdkMessages(contents).map(
    (m) => (m.message.content as Array<{ text?: string }>)[0]?.text,
  );

describe("contentsToSdkMessages", () => {
  test("returns an empty array when no content has a mappable part", () => {
    expect(
      contentsToSdkMessages([
        { role: "user", parts: [{ thought: true, text: "x" }] },
      ]),
    ).toEqual([]);
  });

  test("renders executable code and code execution results as text markers", () => {
    expect(
      texts([
        {
          role: "model",
          parts: [
            { executableCode: { language: Language.PYTHON, code: "print(1)" } },
          ],
        },
        {
          role: "model",
          parts: [
            {
              codeExecutionResult: { outcome: Outcome.OUTCOME_OK, output: "1" },
            },
          ],
        },
        { role: "model", parts: [{ executableCode: {} }] },
        { role: "model", parts: [{ codeExecutionResult: {} }] },
      ]),
    ).toEqual([
      "[code (PYTHON): print(1)]",
      "[exec OUTCOME_OK: 1]",
      "[code (PLAINTEXT): ]",
      "[exec OUTCOME_UNSPECIFIED: ]",
    ]);
  });

  test("stringifies tool call args and tool results, handling empty, string and circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const messages = texts([
      { role: "model", parts: [{ functionCall: { name: "f" } }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "f", response: undefined } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "f",
              response: "ok" as unknown as Record<string, unknown>,
            },
          },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "f", response: { a: 1 } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "f", response: circular } }],
      },
    ]);
    expect(messages).toEqual([
      "[assistant tool-call f({})]",
      "[tool f result: ]",
      "[tool f result: ok]",
      '[tool f result: {"a":1}]',
      "[tool f result: [object Object]]",
    ]);
  });

  test("marks earlier messages synthetic and only the last as shouldQuery", () => {
    const out = contentsToSdkMessages([
      { role: "user", parts: [{ text: "a" }] },
      { role: "model", parts: [{ text: "b" }] },
    ]);
    expect(out[0].isSynthetic).toBe(true);
    expect(out[0].shouldQuery).toBe(false);
    expect(out[1].shouldQuery).toBe(true);
    expect(out[1].message.role).toBe("user");
  });
});
