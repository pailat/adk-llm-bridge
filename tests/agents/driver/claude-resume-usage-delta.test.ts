import { describe, expect, test } from "bun:test";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import type {
  ExternalAgentEvent,
  ExternalAgentUsage,
} from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const MODEL = "claude-haiku-5-5";

/** Counters one run adds to its SDK session. Costs are exact in binary. */
interface Counters {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

const STEP: Counters = {
  inputTokens: 10,
  outputTokens: 4,
  cacheReadInputTokens: 100,
  cacheCreationInputTokens: 20,
  costUSD: 0.25,
};

function times(counters: Counters, n: number): Counters {
  return {
    inputTokens: counters.inputTokens * n,
    outputTokens: counters.outputTokens * n,
    cacheReadInputTokens: counters.cacheReadInputTokens * n,
    cacheCreationInputTokens: counters.cacheCreationInputTokens * n,
    costUSD: counters.costUSD * n,
  };
}

function usageOf(
  counters: Counters,
  scope: "run" | "session",
): ExternalAgentUsage {
  const { costUSD, ...tokens } = counters;
  return { ...tokens, totalCostUsd: costUSD, scope };
}

interface NextRun {
  /** Counters this run adds; `STEP` by default. */
  add?: Counters;
  /** Set the session's counters to `add` instead of adding (a reset). */
  reset?: boolean;
  /** Result subtype; `success` by default. */
  subtype?: string;
}

/**
 * A fake Agent SDK that keeps cumulative counters per SDK session, as the
 * real one does: a resumed session reports the session total, and a fork
 * starts from the parent's counters under a new id.
 */
class FakeClaude {
  readonly totals = new Map<string, Counters>();
  readonly resumes: Array<string | undefined> = [];
  next: NextRun = {};
  #created = 0;

  readonly sdk = {
    query: ({ options }: { options: Record<string, unknown> }) => {
      const resume =
        typeof options.resume === "string" ? options.resume : undefined;
      this.resumes.push(resume);
      const sessionId =
        resume === undefined
          ? `sdk-${++this.#created}`
          : options.forkSession
            ? `fork-${++this.#created}`
            : resume;
      const before =
        (resume !== undefined && this.totals.get(resume)) || times(STEP, 0);
      const run = this.next;
      this.next = {};
      const add = run.add ?? STEP;
      const total = run.reset
        ? add
        : {
            inputTokens: before.inputTokens + add.inputTokens,
            outputTokens: before.outputTokens + add.outputTokens,
            cacheReadInputTokens:
              before.cacheReadInputTokens + add.cacheReadInputTokens,
            cacheCreationInputTokens:
              before.cacheCreationInputTokens + add.cacheCreationInputTokens,
            costUSD: before.costUSD + add.costUSD,
          };
      this.totals.set(sessionId, total);
      const messages = [
        {
          type: "system",
          subtype: "init",
          model: MODEL,
          session_id: sessionId,
          tools: [],
          mcp_servers: [],
        },
        {
          type: "result",
          subtype: run.subtype ?? "success",
          result: "ok",
          ...(run.subtype ? { errors: ["failed"] } : {}),
          session_id: sessionId,
          num_turns: 1,
          duration_ms: 5,
          total_cost_usd: total.costUSD,
          modelUsage: { [MODEL]: { ...total } },
        },
      ];
      return (async function* () {
        yield* messages;
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };

  driver(config: Partial<ClaudeAgentSdkDriverConfig> = {}) {
    // These tests are about usage, not about finding the `claude` binary. An
    // explicit path skips the per-run search of the PATH and the install
    // directories, which made 260 runs cost seconds under load.
    return new ClaudeAgentSdkDriver({
      pathToClaudeCodeExecutable: "/fake/claude",
      ...config,
      sdk: this.sdk,
    } as never);
  }
}

/** Runs one turn in ADK session `adkSession` and returns its usage. */
async function runUsage(
  driver: ClaudeAgentSdkDriver,
  adkSession: string,
  runtimeSessionId?: string,
): Promise<ExternalAgentUsage | undefined> {
  let completed: Extract<ExternalAgentEvent, { type: "completed" }> | undefined;
  for await (const event of driver.run({
    provider: CLAUDE_PROVIDER,
    context: { input: "hi", session: { id: adkSession, state: {} } } as never,
    workingDirectory: "/repo",
    ...(runtimeSessionId ? { runtimeSession: { id: runtimeSessionId } } : {}),
  })) {
    if (event.type === "completed") completed = event;
  }
  return completed?.usage;
}

describe("resumed session usage is per run", () => {
  test("a fresh run reports its own counters, scope run", async () => {
    const fake = new FakeClaude();
    expect(await runUsage(fake.driver(), "a")).toEqual(usageOf(STEP, "run"));
  });

  test("the second run on one driver resumes and reports the delta, scope run", async () => {
    const fake = new FakeClaude();
    const driver = fake.driver();
    await runUsage(driver, "a");
    const add: Counters = {
      inputTokens: 2,
      outputTokens: 7,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 5,
      costUSD: 0.5,
    };
    fake.next = { add };
    expect(await runUsage(driver, "a")).toEqual(usageOf(add, "run"));
    expect(fake.resumes).toEqual([undefined, "sdk-1"]);
  });

  test("a new driver given resumeSessionId reports the session total, scope session", async () => {
    const fake = new FakeClaude();
    await runUsage(fake.driver(), "a");
    const resumed = fake.driver({ resumeSessionId: "sdk-1" });
    expect(await runUsage(resumed, "b")).toEqual(
      usageOf(times(STEP, 2), "session"),
    );
  });

  test("a run resumed from runtimeSession.id with no baseline is scope session", async () => {
    const fake = new FakeClaude();
    await runUsage(fake.driver(), "a");
    expect(await runUsage(fake.driver(), "b", "sdk-1")).toEqual(
      usageOf(times(STEP, 2), "session"),
    );
  });

  test("a fork reports the session total, scope session, even when the parent has a baseline", async () => {
    const fake = new FakeClaude();
    const parent = fake.driver();
    await runUsage(parent, "a");
    const fork = fake.driver({ resumeSessionId: "sdk-1", forkSession: true });
    expect(await runUsage(fork, "b")).toEqual(
      usageOf(times(STEP, 2), "session"),
    );
  });

  test("a counter that went down reports the current total, scope session", async () => {
    const fake = new FakeClaude();
    const driver = fake.driver();
    await runUsage(driver, "a");
    await runUsage(driver, "a");
    fake.next = { add: STEP, reset: true };
    expect(await runUsage(driver, "a")).toEqual(usageOf(STEP, "session"));
  });

  test("interleaved sessions each subtract their own baseline", async () => {
    const fake = new FakeClaude();
    const driver = fake.driver();
    const three = times(STEP, 3);
    expect(await runUsage(driver, "a")).toEqual(usageOf(STEP, "run"));
    fake.next = { add: three };
    expect(await runUsage(driver, "b")).toEqual(usageOf(three, "run"));
    fake.next = { add: three };
    expect(await runUsage(driver, "a")).toEqual(usageOf(three, "run"));
    expect(await runUsage(driver, "b")).toEqual(usageOf(STEP, "run"));
    expect(fake.resumes).toEqual([undefined, undefined, "sdk-1", "sdk-2"]);
  });

  test("a run that ends in an error result is the baseline for the next resume", async () => {
    const fake = new FakeClaude();
    const driver = fake.driver();
    await runUsage(driver, "a");
    fake.next = { subtype: "error_during_execution" };
    expect(await runUsage(driver, "a")).toEqual(usageOf(STEP, "run"));
    expect(await runUsage(driver, "a")).toEqual(usageOf(STEP, "run"));
  });

  test("past 256 sessions the oldest baseline is dropped, so its resume is scope session", async () => {
    const fake = new FakeClaude();
    const driver = fake.driver();
    for (let i = 0; i < 257; i++) await runUsage(driver, `s${i}`);
    expect(await runUsage(driver, "s0")).toEqual(
      usageOf(times(STEP, 2), "session"),
    );
    expect(await runUsage(driver, "s2")).toEqual(usageOf(STEP, "run"));
  });

  test("a session used again is kept when an older one is dropped", async () => {
    const fake = new FakeClaude();
    const driver = fake.driver();
    for (let i = 0; i < 256; i++) await runUsage(driver, `s${i}`);
    await runUsage(driver, "s0");
    await runUsage(driver, "s256");
    expect(await runUsage(driver, "s0")).toEqual(usageOf(STEP, "run"));
    expect(await runUsage(driver, "s1")).toEqual(
      usageOf(times(STEP, 2), "session"),
    );
  });
});
