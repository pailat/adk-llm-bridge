import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createEvent, createEventActions, type Event } from "@google/adk";
import {
  clipWorkflowEventRecord,
  workflowEventRecordsFromAdkEvent,
} from "../../../../src/workflows/storage/event-export-pipeline.js";
import type { WorkflowEventRecordInput } from "../../../../src/workflows/storage/event-exporter.js";

const BASE = {
  workflowId: "wf",
  workflowVersion: "1",
  executionId: "exec-1",
  timestamp: 1_700_000_000_000,
};

const SUMMARY = {
  workflowId: "wf",
  workflowVersion: "1",
  executionId: "exec-1",
  status: "completed",
  steps: 1,
  replayedSteps: 0,
  startedAt: 1,
  completedAt: 2,
};

function workflowAdkEvent(workflowEvent: Record<string, unknown>): Event {
  return createEvent({
    id: `evt-${String(workflowEvent.type)}`,
    invocationId: "inv-1",
    author: "wf",
    timestamp: BASE.timestamp,
    customMetadata: { title: "t", workflow: true, workflowEvent },
  });
}

function one(
  event: Event,
  context?: Parameters<typeof workflowEventRecordsFromAdkEvent>[1],
) {
  const records = workflowEventRecordsFromAdkEvent(event, context);
  expect(records).toHaveLength(1);
  return records[0] as WorkflowEventRecordInput;
}

describe("workflowEventRecordsFromAdkEvent: workflow events", () => {
  const workflowKinds: Array<[string, Record<string, unknown>]> = [
    ["workflow_started", { type: "workflow_started", ...BASE }],
    [
      "workflow_waiting",
      { type: "workflow_waiting", ...BASE, summary: SUMMARY, stepIds: ["s1"] },
    ],
    [
      "workflow_completed",
      { type: "workflow_completed", ...BASE, summary: SUMMARY },
    ],
    ["output", { type: "output", ...BASE, content: "hello" }],
    [
      "error",
      { type: "error", ...BASE, error: { name: "Error", message: "boom" } },
    ],
    ["custom", { type: "custom", ...BASE, name: "n", data: { a: 1 } }],
  ];

  for (const [type, workflowEvent] of workflowKinds) {
    test(`${type} becomes one workflow record with the event as payload`, () => {
      const record = one(workflowAdkEvent(workflowEvent));
      expect(record.kind).toBe("workflow");
      expect(record.type).toBe(type);
      expect(record.id).toBe(`evt-${type}`);
      expect(record.executionId).toBe("exec-1");
      expect(record.workflowId).toBe("wf");
      expect(record.timestamp).toBe(BASE.timestamp);
      expect(record.invocationId).toBe("inv-1");
      expect(record.payload).toEqual(JSON.parse(JSON.stringify(workflowEvent)));
    });
  }

  test("checkpoint_saved keeps the checkpoint key and never the checkpoint state values", () => {
    const event = createEvent({
      id: "evt-cp",
      invocationId: "inv-1",
      author: "wf",
      timestamp: BASE.timestamp,
      actions: createEventActions({
        stateDelta: {
          checkpoint: { secret: "TOP-SECRET-STATE" },
          other: "ALSO-SECRET",
        },
      }),
      customMetadata: {
        workflowEvent: {
          type: "checkpoint_saved",
          ...BASE,
          checkpointKey: "key-123",
          stepId: "s1",
        },
      },
    });
    const record = one(event);
    expect(record.kind).toBe("workflow");
    expect(record.type).toBe("checkpoint_saved");
    expect(record.stepId).toBe("s1");
    const text = JSON.stringify(record);
    expect(text).toContain("key-123");
    expect(text).not.toContain("TOP-SECRET-STATE");
    expect(text).not.toContain("ALSO-SECRET");
    // The size of each value replaces the value.
    const sizeOfCheckpoint = JSON.stringify({
      secret: "TOP-SECRET-STATE",
    }).length;
    expect(text).toContain(String(sizeOfCheckpoint));
  });
});

describe("workflowEventRecordsFromAdkEvent: step events", () => {
  const step = { id: "s1", agentName: "a", input: "hi" };
  const result = { id: "s1", agentName: "a", output: "x", attempts: 1 };
  const stepEvents: Array<
    [string, Record<string, unknown>, Record<string, unknown>]
  > = [
    [
      "step_started",
      { type: "step_started", ...BASE, step, attempt: 2 },
      { stepId: "s1", attempt: 2 },
    ],
    [
      "step_completed",
      { type: "step_completed", ...BASE, result },
      { stepId: "s1" },
    ],
    [
      "step_failed",
      { type: "step_failed", ...BASE, failure: { id: "s1", agentName: "a" } },
      { stepId: "s1" },
    ],
    [
      "step_interrupted",
      { type: "step_interrupted", ...BASE, stepId: "s1", attempt: 3 },
      { stepId: "s1", attempt: 3 },
    ],
    [
      "step_replayed",
      { type: "step_replayed", ...BASE, result },
      { stepId: "s1" },
    ],
    [
      "step_waiting",
      {
        type: "step_waiting",
        ...BASE,
        stepId: "s1",
        agentName: "a",
        attempt: 1,
        kind: "input",
        functionCallIds: ["f1"],
      },
      { stepId: "s1", attempt: 1, agentName: "a" },
    ],
  ];

  for (const [type, workflowEvent, expected] of stepEvents) {
    test(`${type} becomes one step record with its step id`, () => {
      const record = one(workflowAdkEvent(workflowEvent));
      expect(record.kind).toBe("step");
      expect(record.type).toBe(type);
      expect(record.executionId).toBe("exec-1");
      expect(record.workflowId).toBe("wf");
      expect(record.payload).toEqual(JSON.parse(JSON.stringify(workflowEvent)));
      for (const [key, value] of Object.entries(expected)) {
        expect((record as unknown as Record<string, unknown>)[key]).toBe(value);
      }
    });
  }
});

describe("workflowEventRecordsFromAdkEvent: external agent events", () => {
  const meta = { externalAgent: true, title: "t" };

  test("output text becomes an agent_run record of type output", () => {
    const record = one(
      createEvent({
        id: "e-out",
        invocationId: "inv-1",
        author: "claude",
        content: { role: "model", parts: [{ text: "hello" }] },
        customMetadata: meta,
      }),
    );
    expect(record.kind).toBe("agent_run");
    expect(record.type).toBe("output");
    expect(record.agentName).toBe("claude");
    expect(record.executionId).toBe("invocation:inv-1");
    expect(JSON.stringify(record.payload)).toContain("hello");
  });

  test("a tool call becomes type tool_call", () => {
    const record = one(
      createEvent({
        id: "e-call",
        invocationId: "inv-1",
        author: "claude",
        content: {
          role: "model",
          parts: [
            { functionCall: { id: "c1", name: "Read", args: { path: "/a" } } },
          ],
        },
        customMetadata: meta,
      }),
    );
    expect(record.kind).toBe("agent_run");
    expect(record.type).toBe("tool_call");
    expect(JSON.stringify(record.payload)).toContain("Read");
  });

  test("a tool result becomes type tool_result", () => {
    const record = one(
      createEvent({
        id: "e-res",
        invocationId: "inv-1",
        author: "claude",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "c1",
                name: "Read",
                response: { ok: true },
              },
            },
          ],
        },
        customMetadata: meta,
      }),
    );
    expect(record.kind).toBe("agent_run");
    expect(record.type).toBe("tool_result");
  });

  test("an error becomes type error and keeps the code and message", () => {
    const record = one(
      createEvent({
        id: "e-err",
        invocationId: "inv-1",
        author: "claude",
        errorCode: "EXTERNAL_AGENT_ERROR",
        errorMessage: "it broke",
        customMetadata: meta,
      }),
    );
    expect(record.kind).toBe("agent_run");
    expect(record.type).toBe("error");
    const text = JSON.stringify(record.payload);
    expect(text).toContain("EXTERNAL_AGENT_ERROR");
    expect(text).toContain("it broke");
  });

  test("a state delta becomes type state_delta", () => {
    const record = one(
      createEvent({
        id: "e-state",
        invocationId: "inv-1",
        author: "claude",
        actions: createEventActions({ stateDelta: { k: "v" } }),
        customMetadata: meta,
      }),
    );
    expect(record.kind).toBe("agent_run");
    expect(record.type).toBe("state_delta");
    expect(JSON.stringify(record.payload)).toContain('"k"');
  });
});

describe("workflowEventRecordsFromAdkEvent: other events and ids", () => {
  test("any other event is an agent_run record of type adk_event", () => {
    const record = one(
      createEvent({
        id: "plain",
        invocationId: "inv-9",
        author: "agent",
        content: { role: "model", parts: [{ text: "hi" }] },
      }),
    );
    expect(record.kind).toBe("agent_run");
    expect(record.type).toBe("adk_event");
    expect(record.id).toBe("plain");
    expect(record.executionId).toBe("invocation:inv-9");
    expect(record.invocationId).toBe("inv-9");
  });

  test("the context execution id is used when the event names none", () => {
    const record = one(
      createEvent({ id: "p", invocationId: "inv-9", author: "agent" }),
      { executionId: "exec-ctx" },
    );
    expect(record.executionId).toBe("exec-ctx");
  });

  test("the workflow event's execution id wins over the context", () => {
    const record = one(
      workflowAdkEvent({ type: "workflow_started", ...BASE }),
      { executionId: "exec-ctx" },
    );
    expect(record.executionId).toBe("exec-1");
  });

  test("partial events give no record unless includePartial is set", () => {
    const partial = createEvent({
      id: "chunk",
      invocationId: "inv-1",
      author: "agent",
      partial: true,
      content: { role: "model", parts: [{ text: "he" }] },
    });
    expect(workflowEventRecordsFromAdkEvent(partial)).toEqual([]);
    expect(
      workflowEventRecordsFromAdkEvent(partial, { includePartial: false }),
    ).toEqual([]);
    expect(
      workflowEventRecordsFromAdkEvent(partial, { includePartial: true }),
    ).toHaveLength(1);
  });

  test("every record is JSON-safe", () => {
    const record = one(
      createEvent({
        id: "p",
        invocationId: "inv-1",
        author: "agent",
        content: { role: "model", parts: [{ text: "hi" }] },
        customMetadata: { nested: { n: 1 } },
      }),
    );
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

function sizeOf(record: WorkflowEventRecordInput): number {
  return new TextEncoder().encode(JSON.stringify(record)).length;
}

function base(
  payload: WorkflowEventRecordInput["payload"],
): WorkflowEventRecordInput {
  return {
    id: "r1",
    executionId: "exec-1",
    kind: "agent_run",
    type: "output",
    timestamp: 5,
    agentName: "agent",
    stepId: "s1",
    payload,
  };
}

describe("clipWorkflowEventRecord", () => {
  test("a record within the limit is returned unchanged and has no overflow", () => {
    const record = base({ text: "small" });
    const result = clipWorkflowEventRecord(record, { maxRecordBytes: 10_000 });
    expect(result.record).toEqual(record);
    expect(result.record.clipped).toBeUndefined();
    expect(result.overflow).toBeUndefined();
  });

  test("a record exactly at the limit is unchanged", () => {
    const record = base({ text: "abc" });
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: sizeOf(record),
    });
    expect(result.record).toEqual(record);
  });

  test("long strings are cut, end with the clipped marker, and the record fits", () => {
    const record = base({ short: "ok", long: "a".repeat(5_000) });
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_000,
      maxStringBytes: 200,
    });
    const payload = result.record.payload as { short: string; long: string };
    expect(payload.short).toBe("ok");
    expect(payload.long.startsWith("a")).toBe(true);
    expect(payload.long).toMatch(/…\[clipped \d+ bytes\]$/);
    expect(sizeOf(result.record)).toBeLessThanOrEqual(1_000);
    expect(result.record.clipped?.paths).toEqual(["/long"]);
    expect(result.record.clipped?.payloadDropped).toBe(false);
  });

  test("the marker reports how many bytes were removed", () => {
    const record = base({ long: "a".repeat(5_000) });
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_000,
      maxStringBytes: 200,
    });
    const text = (result.record.payload as { long: string }).long;
    const removed = Number(/…\[clipped (\d+) bytes\]$/.exec(text)?.[1]);
    const kept = text.slice(0, text.indexOf("…[clipped")).length;
    expect(kept + removed).toBe(5_000);
  });

  test("clipped records describe the original payload and return its full text", () => {
    const payload = { long: "a".repeat(5_000) };
    const record = base(payload);
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_000,
      maxStringBytes: 200,
    });
    const serialized = JSON.stringify(payload);
    expect(result.overflow).toBe(serialized);
    expect(result.record.clipped?.originalBytes).toBe(
      new TextEncoder().encode(serialized).length,
    );
    expect(result.record.clipped?.sha256).toBe(
      createHash("sha256").update(serialized).digest("hex"),
    );
  });

  test("the envelope is unchanged by clipping", () => {
    const record = base({ long: "a".repeat(5_000) });
    const { payload: _payload, ...envelope } = record;
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_000,
      maxStringBytes: 200,
    });
    const {
      payload: _clippedPayload,
      clipped: _clipped,
      ...after
    } = result.record;
    expect(after).toEqual(envelope);
  });

  test("strings are cut at a character boundary for multi-byte text", () => {
    for (const unit of ["é", "世", "🙂"]) {
      const record = base({ long: unit.repeat(3_000) });
      const result = clipWorkflowEventRecord(record, {
        maxRecordBytes: 2_000,
        maxStringBytes: 101,
      });
      const text = (result.record.payload as { long: string }).long;
      const kept = text.slice(0, text.indexOf("…[clipped"));
      // No broken character: the kept part is whole units only.
      expect(kept.length % unit.length).toBe(0);
      expect(kept).toBe(unit.repeat(kept.length / unit.length));
      expect(kept).not.toContain("�");
      expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(101);
      expect(sizeOf(result.record)).toBeLessThanOrEqual(2_000);
    }
  });

  test("the longest strings are cut first and short ones stay", () => {
    const record = base({
      a: "x".repeat(300),
      b: "y".repeat(9_000),
      c: "z".repeat(120),
    });
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_500,
      maxStringBytes: 200,
    });
    const payload = result.record.payload as Record<string, string>;
    expect(payload.c).toBe("z".repeat(120));
    expect(result.record.clipped?.paths).toContain("/b");
    expect(payload.b).toMatch(/…\[clipped \d+ bytes\]$/);
  });

  test("paths are JSON pointers with escaped keys and array indexes", () => {
    const record = base({
      "a/b": { "c~d": ["short", "q".repeat(5_000)] },
    });
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_000,
      maxStringBytes: 100,
    });
    expect(result.record.clipped?.paths).toEqual(["/a~1b/c~0d/1"]);
  });

  test("when cutting strings is not enough the payload becomes empty and is marked dropped", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) wide[`key${i}`] = "v".repeat(50);
    const record = base(wide);
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 600,
      maxStringBytes: 20,
    });
    expect(result.record.payload).toEqual({});
    expect(result.record.clipped?.payloadDropped).toBe(true);
    expect(result.record.clipped?.paths).toEqual([]);
    expect(result.overflow).toBe(JSON.stringify(wide));
    expect(sizeOf(result.record)).toBeLessThanOrEqual(600);
  });

  test("a payload of many numbers (no strings) is dropped, not cut", () => {
    const record = base({
      numbers: Array.from({ length: 5_000 }, (_, i) => i),
    });
    const result = clipWorkflowEventRecord(record, { maxRecordBytes: 1_000 });
    expect(result.record.payload).toEqual({});
    expect(result.record.clipped?.payloadDropped).toBe(true);
  });

  test("an envelope larger than the limit is rejected with PAYLOAD_TOO_LARGE", () => {
    const record = {
      ...base({}),
      agentName: "n".repeat(250),
      stepId: "s".repeat(250),
    };
    let error: unknown;
    try {
      clipWorkflowEventRecord(record, { maxRecordBytes: 100 });
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string } | undefined)?.code).toBe(
      "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
    );
  });

  test("a payload that is not JSON-safe is rejected with INVALID_RECORD", () => {
    const record = base({ f: () => 1 } as never);
    let error: unknown;
    try {
      clipWorkflowEventRecord(record, { maxRecordBytes: 1_000 });
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string } | undefined)?.code).toBe(
      "WORKFLOW_STORAGE_INVALID_RECORD",
    );
  });

  test("the input record is not mutated", () => {
    const record = base({ long: "a".repeat(5_000) });
    const copy = structuredClone(record);
    clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_000,
      maxStringBytes: 200,
    });
    expect(record).toEqual(copy);
  });
});

describe("clipWorkflowEventRecord: review follow-ups", () => {
  test("only the longest string is cut when that is enough", () => {
    const record = base({
      a: "x".repeat(300),
      b: "y".repeat(9_000),
      c: "z".repeat(120),
    });
    const result = clipWorkflowEventRecord(record, {
      maxRecordBytes: 1_500,
      maxStringBytes: 200,
    });
    expect(result.record.clipped?.paths).toEqual(["/b"]);
    expect((result.record.payload as Record<string, string>).a).toBe(
      "x".repeat(300),
    );
  });

  test("the envelope is unchanged when the whole payload is dropped", () => {
    const record = {
      ...base({ numbers: Array.from({ length: 5_000 }, (_, i) => i) }),
      attempt: 2,
      workflowId: "wf",
    };
    const { payload: _payload, ...envelope } = record;
    const result = clipWorkflowEventRecord(record, { maxRecordBytes: 1_000 });
    const { payload: _p, clipped: _c, ...after } = result.record;
    expect(result.record.clipped?.payloadDropped).toBe(true);
    expect(after).toEqual(envelope);
    expect(result.record.timestamp).toBe(5);
  });
});
