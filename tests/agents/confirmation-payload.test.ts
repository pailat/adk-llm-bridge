import { describe, expect, test } from "bun:test";
import {
  type InvocationContext,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from "@google/adk";
import {
  normalizeDecision,
  readConfirmationAnswers,
} from "../../src/agents/permissions/confirmation.js";

const AGENT = "coder";
const CALL_ID = "adk-confirm-1";

/** A session where `AGENT` asked to confirm `Bash {command: "ls"}`, answered with `response`. */
function answered(response: unknown): InvocationContext {
  return {
    userContent: {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: CALL_ID,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response,
          },
        },
      ],
    },
    session: {
      events: [
        {
          author: AGENT,
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: CALL_ID,
                  name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                  args: {
                    originalFunctionCall: {
                      id: "call-1",
                      name: "Bash",
                      args: { command: "ls" },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  } as unknown as InvocationContext;
}

function answer(response: unknown) {
  const answers = readConfirmationAnswers(answered(response), AGENT);
  expect(answers).toHaveLength(1);
  return answers[0];
}

describe("readConfirmationAnswers", () => {
  test("a plain answer keeps payload and hint", () => {
    expect(
      answer({ confirmed: true, payload: { branch: "main" }, hint: "Run ls" }),
    ).toMatchObject({
      requestCallId: CALL_ID,
      toolName: "Bash",
      confirmed: true,
      payload: { branch: "main" },
      hint: "Run ls",
    });
  });

  test("an answer without payload or hint has neither key", () => {
    const result = answer({ confirmed: true });
    expect(result?.confirmed).toBe(true);
    expect(result && "payload" in result).toBe(false);
    expect(result && "hint" in result).toBe(false);
  });

  test("a wrapped JSON answer approves and keeps its payload", () => {
    expect(
      answer({
        response: JSON.stringify({ confirmed: true, payload: [1, 2] }),
      }),
    ).toMatchObject({ confirmed: true, payload: [1, 2] });
  });

  test("a wrapped answer that does not parse is a rejection", () => {
    for (const response of [
      { response: "{not json" },
      { response: "true" },
      { response: '["confirmed"]' },
      { response: { confirmed: true } },
    ]) {
      expect(answer(response)?.confirmed).toBe(false);
    }
  });

  test("a non-object answer is a rejection", () => {
    expect(answer("yes")?.confirmed).toBe(false);
    expect(answer(null)?.confirmed).toBe(false);
  });

  test("a confirmed value other than true is a rejection", () => {
    expect(answer({ confirmed: "true" })?.confirmed).toBe(false);
  });
});

describe("normalizeDecision keeps the approver payload", () => {
  test("on allow and deny", () => {
    expect(normalizeDecision({ behavior: "allow", payload: { n: 1 } })).toEqual(
      { behavior: "allow", payload: { n: 1 } },
    );
    expect(
      normalizeDecision({ behavior: "deny", message: "", payload: "why" }),
    ).toEqual({
      behavior: "deny",
      message: "Denied by the approver.",
      payload: "why",
    });
  });

  test("adds no payload key when none was given, and drops unknown fields", () => {
    expect(normalizeDecision(true)).toEqual({ behavior: "allow" });
    expect(normalizeDecision({ behavior: "allow", extra: 1 } as never)).toEqual(
      { behavior: "allow" },
    );
  });
});
