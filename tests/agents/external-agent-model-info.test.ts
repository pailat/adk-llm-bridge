/**
 * Every model a run billed is reported (`used`), and the ones nobody asked
 * for are flagged (`unexpected`). `used` is the keys of `usage.byModel`; a
 * run with one billed model has no `byModel`, so a driver that sets
 * `reportsResolvedModel: true` contributes `completed.model` instead.
 */

import { describe, expect, test } from "bun:test";
import type { Event, InvocationContext } from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentModelInfo,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

interface Shape {
  model?: string;
  smallFastModel?: string;
  reportsResolvedModel?: boolean;
}

const usage = (...models: string[]) => ({
  inputTokens: 1,
  byModel: Object.fromEntries(models.map((m) => [m, { inputTokens: 1 }])),
});

function driverOf(
  shape: Shape,
  completed: Partial<Extract<ExternalAgentEvent, { type: "completed" }>>,
): ExternalAgentDriver {
  return {
    providerId: CODEX_PROVIDER.id,
    ...shape,
    async *run() {
      yield { type: "started", providerId: CODEX_PROVIDER.id };
      yield { type: "output", content: "done" };
      yield { type: "completed", exitCode: 0, ...completed };
    },
  } as ExternalAgentDriver;
}

async function infoAfter(
  driver: ExternalAgentDriver,
): Promise<{ info: ExternalAgentModelInfo; event: Event }> {
  const agent = new ExternalAgent({
    name: "agent",
    provider: CODEX_PROVIDER,
    driver,
  });
  const events: Event[] = [];
  for await (const event of agent.runAsync({
    invocationId: "inv-1",
    branch: "root.agent",
  } as InvocationContext)) {
    events.push(event);
  }
  const event = events.at(-1) as Event;
  return {
    event,
    info: event.customMetadata?.externalAgentModel as ExternalAgentModelInfo,
  };
}

describe("used and unexpected", () => {
  test("byModel {a, h}, smallFast h: nothing unexpected", async () => {
    const { info } = await infoAfter(
      driverOf(
        { model: "a", smallFastModel: "h", reportsResolvedModel: true },
        { model: undefined, usage: usage("h", "a") },
      ),
    );
    expect(info.smallFast).toBe("h");
    expect(info.used).toEqual(["a", "h"]);
    expect(info.unexpected).toEqual([]);
  });

  test("without smallFast the helper is unexpected, no warning", async () => {
    const { info, event } = await infoAfter(
      driverOf(
        { model: "a", reportsResolvedModel: true },
        { usage: usage("a", "h") },
      ),
    );
    expect(info.unexpected).toEqual(["h"]);
    expect(info).not.toHaveProperty("smallFast");
    expect(info).not.toHaveProperty("warnings");
    expect(event.customMetadata?.externalAgentModel).not.toHaveProperty(
      "warnings",
    );
  });

  test("under requireExplicitModel the final event warns", async () => {
    const driver = {
      ...driverOf(
        { model: "a", reportsResolvedModel: true },
        { usage: usage("a", "h") },
      ),
      requireExplicitModel: true,
    } as ExternalAgentDriver;
    const { event } = await infoAfter(driver);
    const meta = event.customMetadata?.externalAgentModel as Record<
      string,
      unknown
    >;
    expect(meta.warnings).toEqual(["UNEXPECTED_MODEL"]);
  });

  test("an alias smallFast matches nothing", async () => {
    const { info } = await infoAfter(
      driverOf(
        { model: "a", smallFastModel: "haiku", reportsResolvedModel: true },
        { usage: usage("a", "claude-haiku-5-5") },
      ),
    );
    expect(info.unexpected).toEqual(["claude-haiku-5-5"]);
  });

  test("no byModel and no model: no used, no unexpected", async () => {
    const { info } = await infoAfter(
      driverOf({ model: "gpt-x" }, { usage: { inputTokens: 1 } }),
    );
    expect(info).not.toHaveProperty("used");
    expect(info).not.toHaveProperty("unexpected");
  });

  test("alias requested, resolved id billed: nothing unexpected", async () => {
    const { info } = await infoAfter(
      driverOf(
        { model: "sonnet", reportsResolvedModel: true },
        { usage: usage("claude-sonnet-5-5") },
      ),
    );
    // Only one billed model: the run reports it as the completed model.
    expect(info.resolved).toBeUndefined();
  });

  test("alias requested, resolved id reported at start", async () => {
    const driver = {
      providerId: CODEX_PROVIDER.id,
      model: "sonnet",
      reportsResolvedModel: true,
      async *run() {
        yield {
          type: "started",
          providerId: CODEX_PROVIDER.id,
          model: "claude-sonnet-5-5",
        };
        yield { type: "output", content: "x" };
        yield {
          type: "completed",
          exitCode: 0,
          usage: usage("claude-sonnet-5-5", "claude-sonnet-5-5"),
        };
      },
    } as unknown as ExternalAgentDriver;
    const { info } = await infoAfter(driver);
    expect(info.resolved).toBe("claude-sonnet-5-5");
    expect(info.used).toEqual(["claude-sonnet-5-5"]);
    expect(info.unexpected).toEqual([]);
  });
});

describe("the four sources of used", () => {
  test("two models: the byModel keys, sorted", async () => {
    const { info } = await infoAfter(
      driverOf(
        { model: "b", reportsResolvedModel: false },
        { usage: usage("z", "b") },
      ),
    );
    expect(info.used).toEqual(["b", "z"]);
  });

  test("one model, trusted driver: completed.model", async () => {
    const { info } = await infoAfter(
      driverOf(
        { model: "a", reportsResolvedModel: true },
        { model: "a", usage: { inputTokens: 1 } },
      ),
    );
    expect(info.used).toEqual(["a"]);
    expect(info.unexpected).toEqual([]);
  });

  test("one model, trusted driver: that model is also the resolved one", async () => {
    const { info } = await infoAfter(
      driverOf(
        { model: "a", reportsResolvedModel: true },
        { model: "h", usage: { inputTokens: 1 } },
      ),
    );
    expect(info.resolved).toBe("h");
    expect(info.used).toEqual(["h"]);
    expect(info.unexpected).toEqual([]);
  });

  test("one model, untrusted driver: no used", async () => {
    const { info } = await infoAfter(
      driverOf(
        { model: "a", reportsResolvedModel: false },
        { model: "a", usage: { inputTokens: 1 } },
      ),
    );
    expect(info).not.toHaveProperty("used");
    expect(info).not.toHaveProperty("unexpected");
  });

  test("no model at all: no used", async () => {
    const { info } = await infoAfter(
      driverOf({ model: "a", reportsResolvedModel: true }, {}),
    );
    expect(info).not.toHaveProperty("used");
    expect(info.status).toBe("not-reported");
  });
});

describe("a plan-mode run reports no used (unsupported)", () => {
  test("unsupported status carries no used", async () => {
    const driver = {
      providerId: CODEX_PROVIDER.id,
      model: "a",
      reportsResolvedModel: true,
      async *run() {
        yield {
          type: "started",
          providerId: CODEX_PROVIDER.id,
          modelRouting: "plan-mode",
        };
        yield { type: "output", content: "x" };
        yield { type: "completed", exitCode: 0, usage: usage("a", "b") };
      },
    } as unknown as ExternalAgentDriver;
    const { info } = await infoAfter(driver);
    expect(info.status).toBe("unsupported");
    expect(info.used).toEqual(["a", "b"]);
  });
});
