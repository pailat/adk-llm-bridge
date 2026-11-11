import { describe, expect, test } from "bun:test";
import { InputValidationError } from "@google/adk";
import { ExternalAgentDefinitionRegistry } from "../../../src/agents/agent-registry.js";
import type { ExternalAgentDefinition } from "../../../src/agents/agent-schema.js";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ExternalAgentPolicyError } from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentDriver } from "../../../src/agents/external-agent-driver.js";
import { PlaceholderExternalAgentDriver } from "../../../src/agents/external-agent-driver.js";
import { ExternalAgentWorkflowFactory } from "../../../src/workflows/agents/external-agent-workflow-factory.js";
import { WorkflowAgentFactoryError } from "../../../src/workflows/agents/workflow-agent-factory.js";

interface Options {
  model?: string;
  requireExplicitModel?: boolean;
}

/** A driver that keeps the model and the option, as a built-in one does. */
class KeepingDriver extends PlaceholderExternalAgentDriver {
  readonly model?: string;
  readonly requireExplicitModel?: boolean;
  constructor(id: string, options?: Options) {
    super(id);
    this.model = options?.model;
    this.requireExplicitModel = options?.requireExplicitModel;
  }
}

/** A driver that ignores every option. */
class IgnoringDriver extends PlaceholderExternalAgentDriver {}

interface Spy {
  calls: (Options | undefined)[];
}

function definition(
  id: string,
  make: (options?: Options) => ExternalAgentDriver,
  spy?: Spy,
): ExternalAgentDefinition<Options> {
  return {
    provider: { id, name: id },
    createDriver: (options) => {
      spy?.calls.push(options);
      return make(options);
    },
  };
}

function factoryFor(
  defs: ExternalAgentDefinition<Options>[],
  requireExplicitModel?: boolean,
): ExternalAgentWorkflowFactory {
  return new ExternalAgentWorkflowFactory({
    registry: new ExternalAgentDefinitionRegistry(
      defs as ExternalAgentDefinition[],
    ),
    ...(requireExplicitModel !== undefined ? { requireExplicitModel } : {}),
  });
}

function codeOf(run: () => unknown): { code?: string; cause?: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkflowAgentFactoryError) {
      return { code: error.code, cause: error.cause };
    }
    throw error;
  }
  return {};
}

const keeping = (id: string) => (options?: Options) =>
  new KeepingDriver(id, options);

describe("factory config.model", () => {
  test("reaches createDriver as driverOptions and the descriptor carries it", () => {
    const spy: Spy = { calls: [] };
    const factory = factoryFor([definition("codex", keeping("codex"), spy)]);
    const handle = factory.create({
      providerId: "codex",
      name: "a1",
      config: { model: "gpt-5.5" },
    });
    expect(spy.calls).toEqual([{ model: "gpt-5.5" }]);
    expect(handle.descriptor.model).toBe("gpt-5.5");
    expect(factory.list()[0]?.model).toBe("gpt-5.5");
  });

  test("without a model, createDriver gets no driverOptions and the descriptor has no model key", () => {
    const spy: Spy = { calls: [] };
    const factory = factoryFor([definition("codex", keeping("codex"), spy)]);
    const handle = factory.create({ providerId: "codex", name: "a1" });
    expect(spy.calls).toEqual([undefined]);
    expect("model" in handle.descriptor).toBe(false);
  });

  test("an invalid model is WORKFLOW_AGENT_INVALID_REQUEST and nothing is created", () => {
    const spy: Spy = { calls: [] };
    const factory = factoryFor([definition("codex", keeping("codex"), spy)]);
    for (const model of [
      "",
      " a",
      "a b",
      "-x",
      "a\u0000b",
      "x".repeat(257),
      5,
    ]) {
      const { code } = codeOf(() =>
        factory.create({
          providerId: "codex",
          name: "a1",
          config: { model: model as string },
        }),
      );
      expect(code, String(model)).toBe("WORKFLOW_AGENT_INVALID_REQUEST");
    }
    expect(spy.calls).toEqual([]);
    expect(factory.list()).toEqual([]);
  });

  test("the revision without a model equals the pre-change digest, and a model changes it", () => {
    const make = () => factoryFor([definition("codex", keeping("codex"))]);
    const plain = make().create({
      providerId: "codex",
      name: "a1",
      config: { description: "d" },
    });
    // Golden: sha256 of the canonical {providerId, config} as before the change.
    expect(plain.descriptor.revision).toBe(GOLDEN_NO_MODEL_REVISION);
    const withModel = make().create({
      providerId: "codex",
      name: "a1",
      config: { description: "d", model: "gpt-5.5" },
    });
    expect(withModel.descriptor.revision).not.toBe(plain.descriptor.revision);
    expect(withModel.descriptor.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

/** Revision of `{providerId: "codex", config: {description: "d"}}` at b78ab43. */
const GOLDEN_NO_MODEL_REVISION =
  "sha256:1bb2fe492cf369e7b7c5ac97a2fc76b512fd0e169e0894bc5a966716fee1b8ac";

describe("factory requireExplicitModel", () => {
  test("no model is WORKFLOW_AGENT_MODEL_REQUIRED, before createDriver", () => {
    const spy: Spy = { calls: [] };
    const factory = factoryFor(
      [definition("codex", keeping("codex"), spy)],
      true,
    );
    const { code } = codeOf(() =>
      factory.create({ providerId: "codex", name: "a1" }),
    );
    expect(code).toBe("WORKFLOW_AGENT_MODEL_REQUIRED");
    expect(spy.calls).toEqual([]);
    expect(factory.list()).toEqual([]);
  });

  test("forwards requireExplicitModel to the driver", () => {
    const spy: Spy = { calls: [] };
    const factory = factoryFor(
      [definition("codex", keeping("codex"), spy)],
      true,
    );
    factory.create({
      providerId: "codex",
      name: "a1",
      config: { model: "gpt-5.5" },
    });
    expect(spy.calls).toEqual([
      { model: "gpt-5.5", requireExplicitModel: true },
    ]);
  });

  test("forwards nothing when the factory option is not set or false", () => {
    for (const option of [undefined, false]) {
      const spy: Spy = { calls: [] };
      const factory = factoryFor(
        [definition("codex", keeping("codex"), spy)],
        option,
      );
      factory.create({
        providerId: "codex",
        name: "a1",
        config: { model: "gpt-5.5" },
      });
      expect(spy.calls).toEqual([{ model: "gpt-5.5" }]);
    }
  });

  test("a driver that reports no model is WORKFLOW_AGENT_MODEL_REQUIRED and nothing is registered", () => {
    const factory = factoryFor(
      [definition("custom", () => new IgnoringDriver("custom"))],
      true,
    );
    const { code } = codeOf(() =>
      factory.create({
        providerId: "custom",
        name: "a1",
        config: { model: "m1" },
      }),
    );
    // the driver ignores `model`: required is checked first on its report
    expect(code).toBe("WORKFLOW_AGENT_MODEL_REQUIRED");
    expect(factory.get("a1")).toBeUndefined();
    expect(factory.list()).toEqual([]);
  });

  test("an alias on a built-in provider id is refused before createDriver", () => {
    const cases: [string, string][] = [
      ["claude", "default"],
      ["claude", "BEST"],
      ["claude", "opusplan[1m]"],
      ["gemini-cli", "AUTO"],
      ["gemini-cli", "auto-gemini-3"],
    ];
    for (const [providerId, model] of cases) {
      const spy: Spy = { calls: [] };
      const factory = factoryFor(
        [definition(providerId, keeping(providerId), spy)],
        true,
      );
      const { code } = codeOf(() =>
        factory.create({ providerId, name: "a1", config: { model } }),
      );
      expect(code, `${providerId} ${model}`).toBe(
        "WORKFLOW_AGENT_MODEL_REQUIRED",
      );
      expect(spy.calls, `${providerId} ${model}`).toEqual([]);
    }
  });

  test("plain aliases and full ids stay allowed on a built-in provider id", () => {
    const factory = factoryFor([definition("claude", keeping("claude"))], true);
    for (const [index, model] of ["opus", "claude-opus-5-5"].entries()) {
      const { code } = codeOf(() =>
        factory.create({
          providerId: "claude",
          name: `a${index}`,
          config: { model },
        }),
      );
      expect(code).toBeUndefined();
    }
  });

  test("a custom definition under the id `claude` that drops requireExplicitModel still gets `default` refused", () => {
    const spy: Spy = { calls: [] };
    const dropping = definition(
      "claude",
      (options) => new KeepingDriver("claude", { model: options?.model }),
      spy,
    );
    const factory = factoryFor([dropping], true);
    const { code } = codeOf(() =>
      factory.create({
        providerId: "claude",
        name: "a1",
        config: { model: "default" },
      }),
    );
    expect(code).toBe("WORKFLOW_AGENT_MODEL_REQUIRED");
    expect(spy.calls).toEqual([]);
  });

  test("the alias check is not applied without requireExplicitModel", () => {
    const factory = factoryFor([definition("claude", keeping("claude"))]);
    const { code } = codeOf(() =>
      factory.create({
        providerId: "claude",
        name: "a1",
        config: { model: "default" },
      }),
    );
    expect(code).toBeUndefined();
  });

  test("under a custom provider id, a driver's own refusal is rethrown with the cause", () => {
    const refusing = definition("custom", (options) => {
      if (options?.model === "auto") {
        throw new ExternalAgentPolicyError(
          "EXTERNAL_AGENT_MODEL_REQUIRED",
          "custom: refused",
        );
      }
      return new KeepingDriver("custom", options);
    });
    const factory = factoryFor([refusing], true);
    const failure = codeOf(() =>
      factory.create({
        providerId: "custom",
        name: "a1",
        config: { model: "auto" },
      }),
    );
    expect(failure.code).toBe("WORKFLOW_AGENT_MODEL_REQUIRED");
    expect((failure.cause as { code?: string }).code).toBe(
      "EXTERNAL_AGENT_MODEL_REQUIRED",
    );
    expect(factory.list()).toEqual([]);
  });

  test("a driver error with another code, or a plain Error, passes through unchanged", () => {
    const policy = new ExternalAgentPolicyError(
      "EXTERNAL_AGENT_MODEL_OVERRIDE",
      "custom: model set through args",
    );
    const plain = new Error("boom");
    const invalid = new InputValidationError("bad options");
    for (const thrown of [policy, plain, invalid]) {
      const factory = factoryFor(
        [
          definition("custom", () => {
            throw thrown;
          }),
        ],
        true,
      );
      let caught: unknown;
      try {
        factory.create({
          providerId: "custom",
          name: "a1",
          config: { model: "m1" },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(thrown);
      expect(factory.list()).toEqual([]);
    }
  });

  test("a custom definition that merges its defaults keeps them next to the model", () => {
    const defaults = { hardened: true };
    const seen: unknown[] = [];
    const merging = {
      provider: { id: "custom", name: "custom" },
      createDriver: (options?: Options) => {
        seen.push({ ...defaults, ...options });
        return new KeepingDriver("custom", options);
      },
    } as ExternalAgentDefinition;
    const factory = new ExternalAgentWorkflowFactory({
      registry: new ExternalAgentDefinitionRegistry([merging]),
      requireExplicitModel: true,
    });
    factory.create({
      providerId: "custom",
      name: "a1",
      config: { model: "m1" },
    });
    expect(seen).toEqual([
      { hardened: true, model: "m1", requireExplicitModel: true },
    ]);
  });

  test("under a custom provider id, an alias the custom driver accepts is created (documented limit)", () => {
    const factory = factoryFor([definition("custom", keeping("custom"))], true);
    const { code } = codeOf(() =>
      factory.create({
        providerId: "custom",
        name: "a1",
        config: { model: "auto" },
      }),
    );
    expect(code).toBeUndefined();
  });

  test("a real built-in driver refusal surfaces as WORKFLOW_AGENT_MODEL_REQUIRED with its cause", () => {
    const real = definition(
      "claude-real",
      (options) => new ClaudeAgentSdkDriver(options as never),
    );
    const factory = factoryFor([real], true);
    const failure = codeOf(() =>
      factory.create({
        providerId: "claude-real",
        name: "a1",
        config: { model: "default" },
      }),
    );
    expect(failure.code).toBe("WORKFLOW_AGENT_MODEL_REQUIRED");
  });
});

describe("factory model applied check", () => {
  test("a driver that ignores model is WORKFLOW_AGENT_MODEL_NOT_APPLIED with nothing registered", () => {
    const factory = factoryFor([
      definition("custom", () => new IgnoringDriver("custom")),
    ]);
    const { code } = codeOf(() =>
      factory.create({
        providerId: "custom",
        name: "a1",
        config: { model: "m1" },
      }),
    );
    expect(code).toBe("WORKFLOW_AGENT_MODEL_NOT_APPLIED");
    expect(factory.get("a1")).toBeUndefined();
    expect(factory.list()).toEqual([]);
  });

  test("a driver that keeps another id (alias turned into a full id) is NOT_APPLIED", () => {
    const factory = factoryFor([
      definition(
        "custom",
        () => new KeepingDriver("custom", { model: "full-id" }),
      ),
    ]);
    const { code } = codeOf(() =>
      factory.create({
        providerId: "custom",
        name: "a1",
        config: { model: "alias" },
      }),
    );
    expect(code).toBe("WORKFLOW_AGENT_MODEL_NOT_APPLIED");
    expect(factory.list()).toEqual([]);
  });

  test("a definition without createDriver is NOT_APPLIED", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: new ExternalAgentDefinitionRegistry([
        { provider: { id: "bare", name: "bare" } },
      ]),
    });
    const { code } = codeOf(() =>
      factory.create({
        providerId: "bare",
        name: "a1",
        config: { model: "m1" },
      }),
    );
    expect(code).toBe("WORKFLOW_AGENT_MODEL_NOT_APPLIED");
    expect(factory.get("a1")).toBeUndefined();
    expect(factory.list()).toEqual([]);
  });

  test("a failed comparison does not use up a name or a slot", () => {
    const factory = factoryFor([
      definition("custom", () => new IgnoringDriver("custom")),
    ]);
    expect(
      codeOf(() =>
        factory.create({
          providerId: "custom",
          name: "a1",
          config: { model: "m1" },
        }),
      ).code,
    ).toBe("WORKFLOW_AGENT_MODEL_NOT_APPLIED");
    const retry = codeOf(() =>
      factory.create({ providerId: "custom", name: "a1" }),
    );
    expect(retry.code).toBeUndefined();
  });

  test("no model given: the comparison is skipped", () => {
    const factory = factoryFor([
      definition("custom", () => new IgnoringDriver("custom")),
    ]);
    expect(
      codeOf(() => factory.create({ providerId: "custom", name: "a1" })).code,
    ).toBeUndefined();
  });
});
