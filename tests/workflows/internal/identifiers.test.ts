import { describe, expect, test } from "bun:test";
import { isWorkflowIdentifier } from "../../../src/workflows/internal/identifiers.js";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import { requiredResourceIdentity } from "../../../src/workflows/resources/json.js";
import { InMemoryWorkflowTaskStore } from "../../../src/workflows/tasks/stores.js";

describe("workflow identifier grammars", () => {
  test("each grammar accepts its own characters and lengths", () => {
    expect(isWorkflowIdentifier("task-1.a_b:c", "record")).toBe(true);
    expect(isWorkflowIdentifier("x".repeat(256), "record")).toBe(true);
    expect(isWorkflowIdentifier("x".repeat(257), "record")).toBe(false);
    expect(isWorkflowIdentifier("team/reviewer", "record")).toBe(false);
    expect(isWorkflowIdentifier("team/reviewer", "principal")).toBe(true);
    expect(isWorkflowIdentifier("user@example.com", "principal")).toBe(true);
    expect(isWorkflowIdentifier("refs/heads/main+x", "opaque")).toBe(true);
    expect(isWorkflowIdentifier("user@example.com", "opaque")).toBe(false);
    expect(isWorkflowIdentifier("x".repeat(512), "revision")).toBe(true);
    expect(isWorkflowIdentifier("x".repeat(513), "revision")).toBe(false);
  });

  test("no grammar accepts blanks, spaces, leading separators or non-strings", () => {
    for (const grammar of [
      "record",
      "principal",
      "opaque",
      "revision",
    ] as const) {
      for (const value of ["", " a", "a ", "a b", "-a", ".a", "/a", 7, null]) {
        expect(isWorkflowIdentifier(value, grammar)).toBe(false);
      }
    }
  });

  test("an actor's agent id must be one the task store accepts", async () => {
    const identity = {
      actorId: "team/reviewer",
      agentId: "team/reviewer",
      executionId: "execution-1",
    };
    expect(() => new WorkflowActorContext(identity)).toThrow(
      "Workflow actor agentId is invalid",
    );
    // The principal may still use `@` and `/`.
    expect(
      new WorkflowActorContext({ ...identity, agentId: "reviewer" }).identity
        .actorId,
    ).toBe("team/reviewer");

    const store = new InMemoryWorkflowTaskStore({ now: () => 1 });
    await expect(
      store.create({
        executionId: "execution-1",
        taskId: "task-1",
        agentId: "team/reviewer",
        status: "queued",
        input: {},
        attempts: 0,
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      } as unknown as Parameters<typeof store.create>[0]),
    ).rejects.toThrow("agentId is invalid");
  });

  test("resource ids accept the same 256 characters as plans", () => {
    const id = "r".repeat(256);
    expect(requiredResourceIdentity(id, "artifactId")).toBe(id);
    expect(() => requiredResourceIdentity(`${id}r`, "artifactId")).toThrow(
      "must be a safe 1-256 character resource identity",
    );
  });
});
