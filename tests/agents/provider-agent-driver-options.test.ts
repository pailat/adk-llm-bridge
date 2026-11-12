import { describe, expect, test } from "bun:test";
import { InputValidationError, type InvocationContext } from "@google/adk";
import {
  CLAUDE_PROVIDER,
  ClaudeAgent,
  ClaudeAgentSdkDriver,
  ClaudeCliDriver,
  CodexAgent,
  CodexCliDriver,
  CodexSdkDriver,
  FxAgent,
  FxCliDriver,
  type FxCliSpawn,
  PlaceholderExternalAgentDriver,
} from "../../src/agents/index.js";

function context(): InvocationContext {
  return {
    invocationId: "inv-1",
    session: { id: "s1", state: {}, events: [] },
  } as unknown as InvocationContext;
}

describe("provider agents pass driverOptions to their default driver", () => {
  test("ClaudeAgent builds the SDK driver with the given options", () => {
    const agent = new ClaudeAgent({
      name: "claude",
      driverOptions: {
        model: "claude-haiku-4-5",
        tools: ["Read", "Grep"],
        inheritHostConfig: false,
      },
    });

    expect(agent.driver).toBeInstanceOf(ClaudeAgentSdkDriver);
    expect(agent.driver.model).toBe("claude-haiku-4-5");
    const options = (agent.driver as ClaudeAgentSdkDriver).buildOptions({
      provider: CLAUDE_PROVIDER,
      context: context(),
    });
    expect(options.tools).toEqual(["Read", "Grep"]);
    // The ADK tools of the agent are a different list and stay empty.
    expect(agent.tools).toEqual([]);
  });

  test("CodexAgent builds the SDK driver with the given options", () => {
    const agent = new CodexAgent({
      name: "codex",
      driverOptions: { model: "gpt-5-codex", allowUnenforcedNetwork: true },
    });

    expect(agent.driver).toBeInstanceOf(CodexSdkDriver);
    expect(agent.driver.model).toBe("gpt-5-codex");
  });

  test("FxAgent builds the CLI driver with the given options", () => {
    const spawned: string[] = [];
    const spawn: FxCliSpawn = (command) => {
      spawned.push(command);
      throw new Error("not spawned in tests");
    };
    const agent = new FxAgent({
      name: "fx",
      driverOptions: {
        command: "my-fx",
        model: "anthropic/claude-haiku-4-5",
        spawn,
        killGraceMs: 250,
      },
    });

    expect(agent.driver).toBeInstanceOf(FxCliDriver);
  });

  test("without driverOptions the default driver is used", () => {
    expect(new ClaudeAgent({ name: "a" }).driver).toBeInstanceOf(
      ClaudeAgentSdkDriver,
    );
    expect(new CodexAgent({ name: "b" }).driver).toBeInstanceOf(CodexSdkDriver);
    expect(new FxAgent({ name: "c", driverOptions: { model: "anthropic/claude-haiku-4-5" } }).driver).toBeInstanceOf(FxCliDriver);
  });

  test("the placeholder driver reports EXTERNAL_AGENT_NOT_CONFIGURED, not recoverable", async () => {
    const events = [];
    for await (const event of new PlaceholderExternalAgentDriver(
      "claude",
    ).run()) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "error",
        code: "EXTERNAL_AGENT_NOT_CONFIGURED",
        message: expect.stringContaining("No external agent driver"),
        recoverable: false,
      },
    ]);
  });

  test("an explicit driver is used as before", () => {
    const driver = new PlaceholderExternalAgentDriver("claude");
    expect(new ClaudeAgent({ name: "a", driver }).driver).toBe(driver);
  });

  test("driver and driverOptions together throw", () => {
    const driver = new PlaceholderExternalAgentDriver("claude");
    const build = () =>
      new ClaudeAgent({ name: "a", driver, driverOptions: { model: "m" } });
    expect(build).toThrow(InputValidationError);
    expect(build).toThrow(/either `driver` or `driverOptions`/);
    expect(
      () =>
        new CodexAgent({
          name: "b",
          driver: new PlaceholderExternalAgentDriver("codex"),
          driverOptions: {},
        }),
    ).toThrow(InputValidationError);
    expect(
      () =>
        new FxAgent({
          name: "c",
          driver: new PlaceholderExternalAgentDriver("fx"),
          driverOptions: {},
        }),
    ).toThrow(InputValidationError);
  });

  test("a clone reuses the built driver and can be rebuilt with other options", () => {
    const agent = new ClaudeAgent({
      name: "claude",
      driverOptions: { model: "first" },
    });

    const same = agent.clone({ name: "copy" });
    expect(same.driver).toBe(agent.driver);

    const other = agent.clone({
      name: "other",
      driver: undefined,
      driverOptions: { model: "second" },
    } as never);
    expect(other.driver).not.toBe(agent.driver);
    expect(other.driver.model).toBe("second");

    expect(() =>
      agent.clone({ name: "both", driverOptions: { model: "x" } } as never),
    ).toThrow(InputValidationError);
  });
});

describe("driver option validation", () => {
  test("CLI drivers reject an empty command and an invalid kill grace", () => {
    for (const Driver of [ClaudeCliDriver, CodexCliDriver]) {
      expect(() => new Driver({ command: "" })).toThrow(InputValidationError);
      expect(() => new Driver({ command: "  " })).toThrow(InputValidationError);
      expect(() => new Driver({ killGraceMs: Number.NaN })).toThrow(
        InputValidationError,
      );
      expect(() => new Driver({ killGraceMs: -1 })).toThrow(
        InputValidationError,
      );
      expect(() => new Driver({ killGraceMs: 0 })).not.toThrow();
      expect(() => new Driver({})).not.toThrow();
    }
  });

  test("the Claude SDK driver rejects a maxTurns that is not a positive integer", () => {
    for (const maxTurns of [0, -1, 1.5, Number.NaN]) {
      expect(() => new ClaudeAgentSdkDriver({ maxTurns })).toThrow(
        InputValidationError,
      );
    }
    expect(() => new ClaudeAgentSdkDriver({ maxTurns: 3 })).not.toThrow();
  });
});
