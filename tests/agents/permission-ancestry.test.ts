/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

// B1 (ola3 r2): a nested ExternalAgent that ADK runs directly (a resumable app
// resuming its confirmation, or any direct routing) is never wider than the
// ExternalAgents above it, even with no inherited policy on the session.

import { describe, expect, test } from "bun:test";
import {
  createEvent,
  InMemoryRunner,
  LlmAgent,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../../src/agents/permissions/confirmation.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

interface Seen {
  turn: number;
  permissions: ExternalAgentPermissionPolicy | undefined;
  bash?: PermissionDecision;
  outside?: PermissionDecision;
}

const BASH: PermissionRequest = {
  requestId: "t1",
  toolName: "Bash",
  input: { command: "make deploy" },
};
const OUTSIDE: PermissionRequest = {
  requestId: "t2",
  toolName: "Write",
  input: { file_path: "/etc/evil", content: "x" },
};

function probingDriver(seen: Seen[], turn: () => number): ExternalAgentDriver {
  return {
    providerId: CODEX_PROVIDER.id,
    async *run(request: ExternalAgentRunRequest) {
      const entry: Seen = { turn: turn(), permissions: request.permissions };
      seen.push(entry);
      entry.bash = await request.requestPermission?.(BASH);
      entry.outside = await request.requestPermission?.(OUTSIDE);
      yield { type: "output", content: "child done" };
    },
  };
}

function delegatingDriver(): ExternalAgentDriver {
  return {
    providerId: CODEX_PROVIDER.id,
    async *run(request: ExternalAgentRunRequest) {
      await request.toolGateway?.runSubAgent({
        agentName: "worker",
        task: "write it",
      });
      yield { type: "output", content: "root done" };
    },
  };
}

function worker(
  mode: ExternalAgentPermissionPolicy["mode"],
  seen: Seen[],
  turn: () => number,
) {
  return new ExternalAgent({
    name: "worker",
    provider: CODEX_PROVIDER,
    driver: probingDriver(seen, turn),
    permissions: { mode },
    confirmation: { adk: true },
  });
}

async function resumableRunner(agent: ExternalAgent | LlmAgent) {
  const runner = new InMemoryRunner({
    agent,
    appName: "app",
    resumabilityConfig: { isResumable: true },
  });
  const session = await runner.sessionService.createSession({
    appName: "app",
    userId: "u",
  });
  const run = async (
    newMessage: Parameters<typeof runner.runAsync>[0]["newMessage"],
  ) => {
    const events = [];
    for await (const event of runner.runAsync({
      userId: "u",
      sessionId: session.id,
      newMessage,
    })) {
      events.push(event);
    }
    return events;
  };
  return { runner, session, run };
}

const answer = (id: string | undefined) => ({
  role: "user",
  parts: [
    {
      functionResponse: {
        id,
        name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        response: { confirmed: true },
      },
    },
  ],
});

const DERIVED = { mode: "ask", allowNetwork: false, allowedPaths: ["/repo"] };

describe("ExternalAgent permissions follow its static ancestry (B1)", () => {
  for (const childMode of ["full-access", "workspace-write"] as const) {
    test(`a ${childMode} worker resumed directly keeps the coordinator's ask + /repo`, async () => {
      const seen: Seen[] = [];
      let turn = 1;
      const coordinator = new ExternalAgent({
        name: "coordinator",
        provider: CODEX_PROVIDER,
        driver: delegatingDriver(),
        subAgents: [worker(childMode, seen, () => turn)],
        permissions: { mode: "ask", allowedPaths: ["/repo"] },
      });
      const { run } = await resumableRunner(coordinator);

      const first = await run({ role: "user", parts: [{ text: "go" }] });
      const call = first
        .flatMap((event) => event.content?.parts ?? [])
        .find(
          (part) =>
            part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        )?.functionCall;
      expect(call?.id).toBeDefined();

      turn = 2;
      const second = await run(answer(call?.id));
      // ADK routed the answer straight to the worker.
      expect([...new Set(second.map((event) => event.author))]).toEqual([
        "worker",
      ]);

      const [turn1, turn2] = seen;
      expect(turn1?.permissions).toEqual(DERIVED);
      expect(turn2?.turn).toBe(2);
      expect(turn2?.permissions).toEqual(DERIVED);
      expect(turn2?.bash).toEqual({ behavior: "allow" });
      for (const entry of [turn1, turn2]) {
        expect(entry?.outside).toEqual({
          behavior: "deny",
          message: expect.stringContaining("outside the paths allowed"),
        });
      }
    });
  }

  test("a full-access worker routed directly under a read-only coordinator is read-only", async () => {
    const seen: Seen[] = [];
    const child = worker("full-access", seen, () => 2);
    const coordinator = new ExternalAgent({
      name: "coordinator",
      provider: CODEX_PROVIDER,
      driver: delegatingDriver(),
      subAgents: [child],
      permissions: { mode: "read-only" },
    });
    const { runner, session, run } = await resumableRunner(coordinator);
    // A read-only delegation never pauses, so plant a pending request authored
    // by the worker: that is all ADK's resumption routing looks at.
    await runner.sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: "planted",
        author: "worker",
        content: {
          role: "user",
          parts: [
            {
              functionCall: {
                id: "adk-planted",
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {
                  originalFunctionCall: {
                    id: "t1",
                    name: "Bash",
                    args: BASH.input,
                  },
                  toolConfirmation: { hint: "x", confirmed: false },
                },
              },
            },
          ],
        },
        longRunningToolIds: ["adk-planted"],
      }),
    });

    const events = await run(answer("adk-planted"));

    expect(events.every((event) => event.author === "worker")).toBe(true);
    expect(seen[0]?.permissions?.mode).toBe("read-only");
    for (const decision of [seen[0]?.bash, seen[0]?.outside]) {
      expect(decision).toEqual({
        behavior: "deny",
        message: expect.stringContaining("read-only"),
      });
    }
  });

  test("an ExternalAgent under a plain LlmAgent keeps its own policy", async () => {
    const seen: Seen[] = [];
    const child = worker("full-access", seen, () => 1);
    new LlmAgent({ name: "llm_root", model: "unused", subAgents: [child] });
    expect(child.parentAgent?.name).toBe("llm_root");

    const { run } = await resumableRunner(child);
    await run({ role: "user", parts: [{ text: "go" }] });

    expect(seen[0]?.permissions).toEqual({ mode: "full-access" });
  });

  test("a standalone clone keeps its own policy; a cloned coordinator still caps its workers", async () => {
    const seen: Seen[] = [];
    const coordinator = new ExternalAgent({
      name: "coordinator",
      provider: CODEX_PROVIDER,
      driver: delegatingDriver(),
      subAgents: [worker("full-access", seen, () => 1)],
      permissions: { mode: "ask", allowedPaths: ["/repo"] },
    });
    const original = coordinator.subAgents[0] as ExternalAgent;

    const standalone = original.clone({ name: "standalone" });
    expect(standalone.parentAgent).toBeUndefined();
    await (await resumableRunner(standalone)).run({
      role: "user",
      parts: [{ text: "go" }],
    });
    expect(seen.at(-1)?.permissions).toEqual({ mode: "full-access" });

    const copy = coordinator.clone({ name: "coordinator_copy" });
    const clonedWorker = copy.subAgents[0] as ExternalAgent;
    expect(clonedWorker.parentAgent).toBe(copy);
    await (await resumableRunner(clonedWorker)).run({
      role: "user",
      parts: [{ text: "go" }],
    });
    expect(seen.at(-1)?.permissions).toEqual(DERIVED);
  });
});
