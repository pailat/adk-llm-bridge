import { describe, expect, test } from "bun:test";
import {
  effectiveSavedModel,
  parseWorkflowReplayAcceptances,
  type WorkflowCheckpointStepAcceptanceV1,
} from "../../../src/workflows/checkpoint/replay-acceptance.js";
import {
  isWorkflowCheckpointV1,
  type WorkflowCheckpointStepV1,
  type WorkflowCheckpointV1,
} from "../../../src/workflows/checkpoint/schema.js";
import { WorkflowError } from "../../../src/workflows/contracts.js";
import * as workflows from "../../../src/workflows/index.js";
import { resolveReplayOptions } from "../../../src/workflows/node-config.js";

const H1 = `sha256:${"a".repeat(64)}`;
const H2 = `sha256:${"b".repeat(64)}`;

const entry = (over: Record<string, unknown> = {}) => ({
  executionId: "exec",
  stepId: "s1",
  kind: "input",
  from: H1,
  to: H2,
  reason: "the decision file only gained a trailing newline",
  ...over,
});

function invalid(value: unknown): WorkflowError {
  try {
    parseWorkflowReplayAcceptances(value);
  } catch (caught) {
    expect(caught).toBeInstanceOf(WorkflowError);
    expect((caught as WorkflowError).code).toBe("WORKFLOW_DEFINITION_INVALID");
    return caught as WorkflowError;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be refused`);
}

describe("parseWorkflowReplayAcceptances (test 6 for B)", () => {
  test("accepts well-formed input and model entries and returns frozen copies", () => {
    const source = [
      entry(),
      entry({
        stepId: "s2",
        kind: "model",
        from: "claude-opus-5-5",
        to: "claude-sonnet-5-5",
        approvedBy: "operator / TICKET-1",
      }),
    ];
    const parsed = parseWorkflowReplayAcceptances(source);
    expect(parsed).toEqual(source as never);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(parsed[0]).not.toBe(source[0] as never);
    (source[0] as { to: string }).to = H1;
    expect(parsed[0]?.to).toBe(H2);
  });

  test("an empty list is valid", () => {
    expect(parseWorkflowReplayAcceptances([])).toEqual([]);
  });

  test.each([
    ["not an array", { 0: entry() }],
    ["a string", "[]"],
    ["an entry that is not a plain object", [[entry()]]],
    ["a null entry", [null]],
    ["a sparse array", Array(1)],
    ["an unknown key", [entry({ wildcard: true })]],
    ["an empty executionId", [entry({ executionId: "" })]],
    ["a blank stepId", [entry({ stepId: "  " })]],
    ["a control character in stepId", [entry({ stepId: "s\n1" })]],
    ["a kind other than input or model", [entry({ kind: "agentRevision" })]],
    [
      "an input from that is not a full digest",
      [entry({ from: "sha256:abc" })],
    ],
    ["an uppercase digest", [entry({ to: `sha256:${"A".repeat(64)}` })]],
    ["a digest prefix", [entry({ from: "sha256:" })]],
    [
      "a model id that starts with -",
      [entry({ kind: "model", from: "-m", to: "m2" })],
    ],
    [
      "a model id with whitespace",
      [entry({ kind: "model", from: "m 1", to: "m2" })],
    ],
    ["a model id as input from", [entry({ from: "claude-opus-5-5" })]],
    ["from equal to to", [entry({ to: H1 })]],
    ["an empty reason", [entry({ reason: "" })]],
    ["a blank reason", [entry({ reason: "   " })]],
    ["a reason over 512 characters", [entry({ reason: "r".repeat(513) })]],
    ["a control character in reason", [entry({ reason: "ok\u0007" })]],
    ["a line separator in reason", [entry({ reason: "ok\u2028x" })]],
    ["an empty approvedBy", [entry({ approvedBy: "" })]],
    ["an approvedBy over 128", [entry({ approvedBy: "a".repeat(129) })]],
    ["a non-string reason", [entry({ reason: 7 })]],
    [
      "two entries for the same execution, step and kind",
      [entry(), entry({ reason: "again" })],
    ],
  ])("refuses %s", (_label, value) => {
    invalid(value);
  });

  test("a reason of exactly 512 and an approvedBy of exactly 128 are valid", () => {
    expect(() =>
      parseWorkflowReplayAcceptances([
        entry({ reason: "r".repeat(512), approvedBy: "a".repeat(128) }),
      ]),
    ).not.toThrow();
  });

  test("the same step and kind in two executions is valid", () => {
    expect(() =>
      parseWorkflowReplayAcceptances([
        entry(),
        entry({ executionId: "other" }),
      ]),
    ).not.toThrow();
  });

  test("more than 1000 entries are refused, 1000 are accepted", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        entry({ stepId: `s${index}` }),
      );
    expect(parseWorkflowReplayAcceptances(many(1000))).toHaveLength(1000);
    invalid(many(1001));
  });

  test("an accessor property is refused and never called", () => {
    let calls = 0;
    const tricky = entry();
    Object.defineProperty(tricky, "to", {
      enumerable: true,
      get() {
        calls++;
        return calls === 1 ? H2 : H1;
      },
    });
    invalid([tricky]);
    expect(calls).toBe(0);
  });

  test("a symbol key and an exotic prototype are refused", () => {
    invalid([{ ...entry(), [Symbol("x")]: 1 }]);
    invalid([Object.assign(Object.create({ kind: "input" }), entry())]);
  });

  test("the error never echoes the reason text", () => {
    const error = invalid([entry({ reason: "secret note\u0007" })]);
    expect(JSON.stringify(error.toJSON())).not.toContain("secret note");
  });

  test("is exported from ./workflows", () => {
    expect(workflows.parseWorkflowReplayAcceptances).toBe(
      parseWorkflowReplayAcceptances,
    );
  });
});

describe("replay.acceptChanges option", () => {
  test("is validated with the same rules", () => {
    expect(() =>
      resolveReplayOptions({
        replay: { acceptChanges: [entry({ to: H1 })] as never },
      }),
    ).toThrow(WorkflowError);
    expect(() =>
      resolveReplayOptions({ replay: { acceptChanges: "all" as never } }),
    ).toThrow(WorkflowError);
  });

  test("defaults to no acceptances, and the resolved list is a frozen copy", () => {
    expect(resolveReplayOptions({}).acceptChanges).toEqual([]);
    const list = [entry()];
    const resolved = resolveReplayOptions({
      replay: { acceptChanges: list as never },
    });
    list.push(entry({ stepId: "s9" }));
    (list[0] as { to: string }).to = `sha256:${"c".repeat(64)}`;
    expect(resolved.acceptChanges).toHaveLength(1);
    expect(resolved.acceptChanges[0]?.to).toBe(H2);
    expect(Object.isFrozen(resolved.acceptChanges)).toBe(true);
  });
});

function checkpointWith(
  step: Partial<WorkflowCheckpointStepV1> & Record<string, unknown>,
): WorkflowCheckpointV1 {
  return {
    schemaVersion: 1,
    workflowId: "wf",
    workflowVersion: "1",
    executionId: "exec",
    inputHash: H1,
    status: "running",
    steps: {
      s1: {
        id: "s1",
        agentName: "worker",
        inputHash: H2,
        status: "completed",
        attempts: 1,
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        result: {
          status: "completed",
          id: "s1",
          agentName: "worker",
          output: "done",
          attempts: 1,
          startedAt: 1,
          completedAt: 2,
        },
        ...step,
      } as WorkflowCheckpointStepV1,
    },
    startedAt: 1,
    updatedAt: 2,
  };
}

const stored = (over: Record<string, unknown> = {}) =>
  ({
    kind: "input",
    from: H1,
    to: H2,
    reason: "equivalent",
    acceptedAt: 5,
    ...over,
  }) as unknown as WorkflowCheckpointStepAcceptanceV1;

describe("stored acceptances (validator)", () => {
  test("a completed step with well-formed entries loads", () => {
    expect(
      isWorkflowCheckpointV1(
        checkpointWith({
          acceptances: [
            stored(),
            stored({
              kind: "model",
              from: "m1",
              to: "m2",
              approvedBy: "ops",
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  test.each([
    ["not an array", { 0: stored() }],
    ["an empty array", []],
    ["an unknown key", [stored({ extra: 1 })]],
    ["an unknown kind", [stored({ kind: "agentRevision" })]],
    ["a malformed input digest", [stored({ from: "sha256:1" })]],
    ["from equal to to", [stored({ to: H1 })]],
    ["a control character in reason", [stored({ reason: "a\nb" })]],
    ["an empty reason", [stored({ reason: "" })]],
    ["a non-finite acceptedAt", [stored({ acceptedAt: null })]],
    ["a missing acceptedAt", [stored({ acceptedAt: undefined })]],
    ["33 entries", Array.from({ length: 33 }, () => stored())],
  ])("an acceptances field with %s is corrupt", (_label, acceptances) => {
    expect(
      isWorkflowCheckpointV1(
        checkpointWith({ acceptances: acceptances as never }),
      ),
    ).toBe(false);
  });

  test("32 entries load", () => {
    expect(
      isWorkflowCheckpointV1(
        checkpointWith({
          acceptances: Array.from({ length: 32 }, () => stored()),
        }),
      ),
    ).toBe(true);
  });

  test("acceptances on a step that is not completed is corrupt", () => {
    const failed = checkpointWith({
      status: "failed",
      result: undefined,
      error: { code: "WORKFLOW_EXECUTION_ERROR", message: "x" },
      acceptances: [stored()],
    });
    expect(isWorkflowCheckpointV1(failed)).toBe(false);
    const { acceptances: _drop, ...plain } = failed.steps.s1 as never as Record<
      string,
      unknown
    >;
    expect(
      isWorkflowCheckpointV1({ ...failed, steps: { s1: plain } as never }),
    ).toBe(true);
  });

  test("a stored error with WORKFLOW_REPLAY_ACCEPTANCE_INVALID loads", () => {
    const checkpoint: WorkflowCheckpointV1 = {
      ...checkpointWith({}),
      status: "failed",
      completedAt: 3,
      updatedAt: 3,
      error: {
        code: "WORKFLOW_REPLAY_ACCEPTANCE_INVALID",
        message: "stale acceptance",
      },
    };
    expect(isWorkflowCheckpointV1(checkpoint)).toBe(true);
  });
});

describe("effective saved model", () => {
  test("is the last model acceptance's to, else model.requested", () => {
    const base = checkpointWith({ model: { requested: "m1" } }).steps.s1;
    expect(effectiveSavedModel(base as WorkflowCheckpointStepV1)).toBe("m1");
    const accepted = checkpointWith({
      model: { requested: "m1" },
      acceptances: [
        stored({ kind: "model", from: "m1", to: "m2" }),
        stored(),
        stored({ kind: "model", from: "m2", to: "m3" }),
      ],
    }).steps.s1;
    expect(effectiveSavedModel(accepted as WorkflowCheckpointStepV1)).toBe(
      "m3",
    );
    const none = checkpointWith({}).steps.s1;
    expect(effectiveSavedModel(none as WorkflowCheckpointStepV1)).toBe(
      undefined,
    );
  });
});
