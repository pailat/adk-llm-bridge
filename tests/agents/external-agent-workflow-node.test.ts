import { describe, expect, test } from "bun:test";
import { InMemoryRunner, Workflow } from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { withDeadline } from "./helpers.js";

/**
 * The BaseNode options accepted by ExternalAgentConfig (`timeout`,
 * `retryConfig`, ...) are honored by ADK when the agent runs as a Workflow
 * node, and the driver contract (abort signal, clean re-run) holds.
 */

function scripted(
  run: (request: ExternalAgentRunRequest) => AsyncIterable<ExternalAgentEvent>,
): ExternalAgentDriver {
  return { providerId: CODEX_PROVIDER.id, run };
}

async function runNode(agent: ExternalAgent) {
  const received: unknown[] = [];
  const sink = Object.defineProperty(
    (_ctx: unknown, input: unknown) => {
      received.push(input);
      return "done";
    },
    "name",
    { value: "sink" },
  );
  const runner = new InMemoryRunner({
    agent: new Workflow({
      name: "wf",
      edges: [["START", agent, sink]],
    } as never) as never,
    appName: "app",
  });
  const session = await runner.sessionService.createSession({
    appName: "app",
    userId: "user",
  });
  const errors: string[] = [];
  try {
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "go" }] },
    })) {
      if (event.errorCode) errors.push(event.errorMessage ?? event.errorCode);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { received, errors };
}

describe("ExternalAgent as an ADK Workflow node", () => {
  test("timeout aborts the driver through request.abortSignal", async () => {
    let signal: AbortSignal | undefined;
    let driverCleanedUp = false;
    const agent = new ExternalAgent({
      name: "slow",
      provider: CODEX_PROVIDER,
      timeout: 0.05, // seconds, ADK BaseNodeConfig.timeout
      driver: scripted(async function* (request) {
        signal = request.abortSignal;
        try {
          yield { type: "output", content: "working", partial: true };
          await new Promise<never>((_, reject) => {
            request.abortSignal?.addEventListener("abort", () =>
              reject(new Error("driver aborted")),
            );
          });
        } finally {
          driverCleanedUp = true;
        }
      }),
    });

    const { received, errors } = await withDeadline(
      runNode(agent),
      5000,
      "workflow did not time out the node",
    );

    expect(signal?.aborted).toBe(true);
    expect(driverCleanedUp).toBe(true);
    expect(received).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("retryConfig re-runs the agent cleanly after a failed attempt", async () => {
    let attempts = 0;
    const agent = new ExternalAgent({
      name: "flaky",
      provider: CODEX_PROVIDER,
      retryConfig: { maxAttempts: 3, initialDelay: 0, jitter: 0 },
      driver: scripted(async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient failure");
        }
        yield { type: "output", content: `attempt ${attempts}` };
      }),
    });

    const { received, errors } = await withDeadline(
      runNode(agent),
      5000,
      "retry did not finish",
    );

    expect(errors).toEqual([]);
    expect(attempts).toBe(2);
    expect(received).toEqual(["attempt 2"]);
  });

  test("rerunOnResume and waitForOutput are accepted and exposed on the node", () => {
    const agent = new ExternalAgent({
      name: "resumable",
      provider: CODEX_PROVIDER,
      rerunOnResume: true,
      waitForOutput: true,
      driver: scripted(async function* () {
        yield { type: "output", content: "x" };
      }),
    });

    expect(agent.rerunOnResume).toBe(true);
    expect(agent.waitForOutput).toBe(true);
    expect(agent.clone().rerunOnResume).toBe(true);
  });
});
