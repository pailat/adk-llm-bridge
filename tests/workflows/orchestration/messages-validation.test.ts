import { describe, expect, test } from "bun:test";
import {
  isWorkflowOrchestrationMessage,
  parseWorkflowOrchestrationMessage,
} from "../../../src/workflows/orchestration/messages.js";

const base = (
  kind: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
) => ({
  protocol: "adk-llm-bridge/orchestration-message",
  version: 1,
  messageId: "m1",
  executionId: "e1",
  planRevision: 1,
  senderTaskId: "a",
  recipientTaskId: "b",
  createdAt: 10,
  kind,
  payload,
  ...extra,
});

const valid: Record<string, unknown> = {
  ContractPublished: { contractId: "c1", paths: ["src/a.ts"], summary: "s" },
  DependencyRequest: { dependencyTaskId: "d", request: "r" },
  DependencyResponse: {
    requestMessageId: "m0",
    outcome: "accepted",
    response: "ok",
  },
  OwnershipRequest: { proposalId: "p" },
  OwnershipDecision: { proposalId: "p", status: "approved" },
  PathCreated: { path: "src/new.ts" },
  IntegrationRequest: { commit: "abc", changedPaths: [] },
  ReviewFinding: { severity: "warning", summary: "s", paths: ["src/a.ts"] },
  Blocker: { summary: "s", blockedTaskIds: ["x"] },
};

const code = (v: unknown) => {
  try {
    parseWorkflowOrchestrationMessage(v);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "no-throw";
};

describe("parseWorkflowOrchestrationMessage", () => {
  test.each(Object.keys(valid))(
    "accepts a valid %s message and returns a frozen copy",
    (kind) => {
      const input = base(kind, valid[kind]);
      const out = parseWorkflowOrchestrationMessage(input);
      expect(out).toEqual(input as typeof out);
      expect(out).not.toBe(input as typeof out);
      expect(Object.isFrozen(out)).toBe(true);
    },
  );

  test("rejects non-object, array, non-plain and unknown-field envelopes", () => {
    for (const v of [
      null,
      "x",
      [],
      new Date(),
      base("Blocker", valid.Blocker, { extra: 1 }),
    ]) {
      expect(code(v)).toBe("WORKFLOW_ORCHESTRATION_INVALID_REQUEST");
    }
  });

  test("rejects wrong protocol, version and unknown kind", () => {
    expect(code(base("Blocker", valid.Blocker, { protocol: "x" }))).toBe(
      "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    );
    expect(code(base("Blocker", valid.Blocker, { version: 2 }))).toBe(
      "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    );
    expect(code(base("Nope", {}))).toBe(
      "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    );
  });

  test("rejects invalid scalar fields and payload contents", () => {
    const bad = [
      base("Blocker", valid.Blocker, { planRevision: 0 }),
      base("Blocker", valid.Blocker, { createdAt: -1 }),
      base("Blocker", valid.Blocker, { messageId: "bad id!" }),
      base("Blocker", valid.Blocker, { correlationId: "bad id!" }),
      base("ContractPublished", {
        ...(valid.ContractPublished as object),
        paths: [],
      }),
      base("ContractPublished", {
        ...(valid.ContractPublished as object),
        paths: ["src/a.ts", "src/a.ts"],
      }),
      base("DependencyResponse", {
        ...(valid.DependencyResponse as object),
        outcome: "maybe",
      }),
      base("OwnershipDecision", {
        proposalId: "p",
        status: "approved",
        reason: " padded ",
      }),
      base("PathCreated", { path: 5 }),
      base("Blocker", { summary: "s", blockedTaskIds: ["x", "x"] }),
      base("ReviewFinding", { ...(valid.ReviewFinding as object), extra: 1 }),
    ];
    for (const v of bad)
      expect(code(v)).toBe("WORKFLOW_ORCHESTRATION_INVALID_REQUEST");
  });
});

describe("isWorkflowOrchestrationMessage", () => {
  test("returns true for valid and false for invalid messages without throwing", () => {
    expect(
      isWorkflowOrchestrationMessage(base("PathCreated", valid.PathCreated)),
    ).toBe(true);
    expect(isWorkflowOrchestrationMessage({})).toBe(false);
  });
});
