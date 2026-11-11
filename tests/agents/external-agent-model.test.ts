import { describe, expect, test } from "bun:test";
import type { Event, InvocationContext } from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentModelInfo,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

interface DriverShape {
  model?: string;
  reportsResolvedModel?: boolean;
}

/** A driver with a chosen model, trust flag and event list. */
function driverOf(
  shape: DriverShape,
  events: ExternalAgentEvent[],
): ExternalAgentDriver {
  return {
    providerId: CODEX_PROVIDER.id,
    ...shape,
    async *run() {
      yield* events;
    },
  };
}

async function collect(driver: ExternalAgentDriver): Promise<Event[]> {
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
  return events;
}

function infoOf(event: Event | undefined): ExternalAgentModelInfo | undefined {
  return event?.customMetadata?.externalAgentModel as
    | ExternalAgentModelInfo
    | undefined;
}

const text = (content: string): ExternalAgentEvent => ({
  type: "output",
  content,
});
const started = (model?: string, extra = {}): ExternalAgentEvent => ({
  type: "started",
  providerId: CODEX_PROVIDER.id,
  ...(model ? { model } : {}),
  ...extra,
});
const completed = (model?: string): ExternalAgentEvent => ({
  type: "completed",
  exitCode: 0,
  ...(model ? { model } : {}),
});

describe("ExternalAgent model info: status matrix", () => {
  test("a trusting driver with a reported model: reported, resolved, modelVersion", async () => {
    const events = await collect(
      driverOf({ model: "opus", reportsResolvedModel: true }, [
        started("claude-opus-5-5"),
        text("done"),
        completed(),
      ]),
    );
    const last = events.at(-1);
    expect(infoOf(last)).toEqual({
      requested: "opus",
      resolved: "claude-opus-5-5",
      status: "reported",
    });
    expect(last?.modelVersion).toBe("claude-opus-5-5");
  });

  test("the completed event's model wins over the started event's", async () => {
    const events = await collect(
      driverOf({ reportsResolvedModel: true }, [
        started("from-started"),
        text("done"),
        completed("from-completed"),
      ]),
    );
    expect(infoOf(events.at(-1))?.resolved).toBe("from-completed");
    expect(events.at(-1)?.modelVersion).toBe("from-completed");
  });

  test("a trusting driver with no model on its events: not-reported, no resolved, no modelVersion", async () => {
    const events = await collect(
      driverOf({ model: "gpt-5.5", reportsResolvedModel: true }, [
        started(),
        text("done"),
        completed(),
      ]),
    );
    const last = events.at(-1);
    expect(infoOf(last)).toEqual({
      requested: "gpt-5.5",
      status: "not-reported",
    });
    expect(last?.modelVersion).toBeUndefined();
  });

  for (const trust of [false, undefined]) {
    test(`reportsResolvedModel ${String(trust)}: unsupported, the event model is ignored`, async () => {
      const events = await collect(
        driverOf(
          {
            model: "gemini-3-pro",
            ...(trust === undefined ? {} : { reportsResolvedModel: trust }),
          },
          [started("something-else"), text("done"), completed("another")],
        ),
      );
      const last = events.at(-1);
      expect(infoOf(last)).toEqual({
        requested: "gemini-3-pro",
        status: "unsupported",
      });
      expect(last?.modelVersion).toBeUndefined();
    });
  }

  test("a Codex-like driver (no resolved model): unsupported with requested only", async () => {
    const events = await collect(
      driverOf({ model: "gpt-5.5", reportsResolvedModel: false }, [
        started(),
        text("done"),
        completed(),
      ]),
    );
    expect(infoOf(events.at(-1))).toEqual({
      requested: "gpt-5.5",
      status: "unsupported",
    });
  });

  test("a driver without a model has no requested", async () => {
    const events = await collect(
      driverOf({ reportsResolvedModel: false }, [text("done"), completed()]),
    );
    const info = infoOf(events.at(-1));
    expect(info).toEqual({ status: "unsupported" });
    expect("requested" in (info ?? {})).toBe(false);
  });

  test("an empty or blank driver model is not a requested id", async () => {
    const events = await collect(
      driverOf({ model: "", reportsResolvedModel: false }, [
        text("done"),
        completed(),
      ]),
    );
    expect(infoOf(events.at(-1))).toEqual({ status: "unsupported" });
  });

  test("an empty reported model counts as not reported", async () => {
    const events = await collect(
      driverOf({ reportsResolvedModel: true }, [
        { type: "started", providerId: CODEX_PROVIDER.id, model: "" },
        text("done"),
        completed(),
      ]),
    );
    expect(infoOf(events.at(-1))?.status).toBe("not-reported");
  });

  test("a plan-mode run is unsupported even from a trusting driver with a model on its events", async () => {
    const events = await collect(
      driverOf({ model: "gemini-3-pro", reportsResolvedModel: true }, [
        started("gemini-2.5-flash", { modelRouting: "plan-mode" }),
        text("done"),
        completed("gemini-2.5-flash"),
      ]),
    );
    const last = events.at(-1);
    expect(infoOf(last)).toEqual({
      requested: "gemini-3-pro",
      status: "unsupported",
    });
    expect(last?.modelVersion).toBeUndefined();
  });
});

describe("ExternalAgent model info: a mismatch is visible", () => {
  test("with a full-id request, an init model that differs shows requested != resolved (an alias request would differ always, so only a full id makes the mismatch meaningful)", async () => {
    const events = await collect(
      driverOf({ model: "claude-opus-5-5", reportsResolvedModel: true }, [
        started("claude-sonnet-5-5"),
        text("done"),
        completed(),
      ]),
    );
    expect(infoOf(events.at(-1))).toEqual({
      requested: "claude-opus-5-5",
      resolved: "claude-sonnet-5-5",
      status: "reported",
    });
  });

  test("a settings remap of the start model shows the same way, with a full id", async () => {
    // Loaded Claude settings (availableModels, env remaps) can replace the
    // start model; the run reports what it started with.
    const events = await collect(
      driverOf({ model: "claude-haiku-5-5", reportsResolvedModel: true }, [
        started("claude-sonnet-5-5"),
        text("done"),
        completed("claude-sonnet-5-5"),
      ]),
    );
    const info = infoOf(events.at(-1));
    expect(info?.requested).not.toBe(info?.resolved);
  });
});

describe("ExternalAgent model info: placement", () => {
  test("rides on the held final event, once, and partial events never carry it", async () => {
    const events = await collect(
      driverOf({ model: "m", reportsResolvedModel: true }, [
        started("m-full"),
        { type: "output", content: "typ", partial: true },
        text("done"),
        completed(),
      ]),
    );
    const carrying = events.filter((event) => infoOf(event) !== undefined);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.partial).toBeFalsy();
    expect(carrying[0]?.content?.parts?.[0]?.text).toBe("done");
    expect(events.filter((e) => e.partial).every((e) => !infoOf(e))).toBe(true);
  });

  test("a run with no final text puts the info on its last error event", async () => {
    const events = await collect(
      driverOf({ model: "m", reportsResolvedModel: true }, [
        started("m-full"),
        { type: "error", message: "first", code: "E1" },
        { type: "error", message: "second", code: "E2" },
        completed(),
      ]),
    );
    const withInfo = events.filter((event) => infoOf(event) !== undefined);
    expect(withInfo).toHaveLength(1);
    expect(withInfo[0]?.errorMessage).toBe("second");
    expect(infoOf(withInfo[0])?.status).toBe("reported");
    // Event order is unchanged.
    expect(events.map((e) => e.errorMessage)).toEqual(["first", "second"]);
  });

  test("a run with neither a final text nor an error attaches nothing", async () => {
    const events = await collect(
      driverOf({ model: "m", reportsResolvedModel: true }, [
        started("m-full"),
        completed(),
      ]),
    );
    expect(events.some((event) => infoOf(event) !== undefined)).toBe(false);
  });

  test("a run that ends without a completed event attaches nothing", async () => {
    const events = await collect(
      driverOf({ model: "m", reportsResolvedModel: true }, [
        started("m-full"),
        text("done"),
      ]),
    );
    expect(events.some((event) => infoOf(event) !== undefined)).toBe(false);
  });

  test("the final text wins over an earlier error", async () => {
    const events = await collect(
      driverOf({ model: "m", reportsResolvedModel: true }, [
        started("m-full"),
        { type: "error", message: "early", code: "E1" },
        text("done"),
        completed(),
      ]),
    );
    const withInfo = events.filter((event) => infoOf(event) !== undefined);
    expect(withInfo).toHaveLength(1);
    expect(withInfo[0]?.content?.parts?.[0]?.text).toBe("done");
  });
});
