import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  type Event,
  type InvocationContext,
  LlmAgent,
  type LlmResponse,
  SequentialAgent,
} from "@google/adk";
import { ExternalAgent } from "../../src/agents/external-agent.js";
import type {
  ExternalAgentDriver,
  ExternalAgentEvent,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import {
  AgentInvocationGateway,
  type AgentInvocationResult,
} from "../../src/runtime/agent-invocation-gateway.js";
import {
  parentContext,
  ScriptAgent,
  Trace,
} from "./gateway-characterization/scenarios.js";

class RootAgent extends BaseAgent {
  constructor() {
    super({ name: "root" });
  }
  protected async *runAsyncImpl() {}
  protected async *runLiveImpl() {}
}

class NamedLlm extends BaseLlm {
  constructor(
    model: string,
    private readonly reply: LlmResponse,
  ) {
    super({ model });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield this.reply;
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("not implemented");
  }
}

const reply = (modelVersion?: string): LlmResponse => ({
  content: { role: "model", parts: [{ text: "ok" }] },
  ...(modelVersion ? { modelVersion } : {}),
});

function external(
  name: string,
  shape: { model?: string; reportsResolvedModel?: boolean },
  events: ExternalAgentEvent[],
): ExternalAgent {
  const driver: ExternalAgentDriver = {
    providerId: CODEX_PROVIDER.id,
    ...shape,
    async *run() {
      yield* events;
    },
  };
  return new ExternalAgent({ name, provider: CODEX_PROVIDER, driver });
}

const started = (model?: string): ExternalAgentEvent => ({
  type: "started",
  providerId: CODEX_PROVIDER.id,
  ...(model ? { model } : {}),
});

async function run(agent: BaseAgent): Promise<AgentInvocationResult> {
  const gateway = new AgentInvocationGateway({
    resolveAgent: (name) => (name === agent.name ? agent : undefined),
  });
  return gateway.run({
    agentName: agent.name,
    input: { role: "user", parts: [{ text: "go" }] },
    parentContext: parentContext(new RootAgent()),
  });
}

describe("gateway models: external runs", () => {
  test("a reporting run: requested, resolved, not unknown", async () => {
    const result = await run(
      external("e", { model: "claude-opus-5-5", reportsResolvedModel: true }, [
        started("claude-opus-5-5"),
        { type: "output", content: "done" },
        { type: "completed", exitCode: 0 },
      ]),
    );
    expect(result.models).toEqual({
      requested: ["claude-opus-5-5"],
      resolved: ["claude-opus-5-5"],
      unknown: false,
    });
  });

  test("a Codex-like run: requested only, unknown", async () => {
    const result = await run(
      external("e", { model: "gpt-5.5", reportsResolvedModel: false }, [
        { type: "output", content: "done" },
        { type: "completed", exitCode: 0 },
      ]),
    );
    expect(result.models).toEqual({
      requested: ["gpt-5.5"],
      resolved: [],
      unknown: true,
    });
  });

  test("an external run with no model of its own is unknown", async () => {
    const result = await run(
      external("e", { reportsResolvedModel: true }, [
        started("claude-opus-5-5"),
        { type: "output", content: "done" },
        { type: "completed", exitCode: 0 },
      ]),
    );
    expect(result.models).toEqual({
      requested: [],
      resolved: ["claude-opus-5-5"],
      unknown: true,
    });
  });

  test("an external run that never completed has no model info: unknown", async () => {
    const result = await run(
      external("e", { model: "gpt-5.5", reportsResolvedModel: true }, [
        { type: "output", content: "done" },
      ]),
    );
    expect(result.models).toEqual({
      requested: ["gpt-5.5"],
      resolved: [],
      unknown: true,
    });
  });

  test("a not-reported status is unknown even with a requested model", async () => {
    const result = await run(
      external("e", { model: "m", reportsResolvedModel: true }, [
        started(),
        { type: "output", content: "done" },
        { type: "completed", exitCode: 0 },
      ]),
    );
    expect(result.models?.unknown).toBe(true);
    expect(result.models?.resolved).toEqual([]);
  });
});

describe("gateway models: LlmAgent", () => {
  test("a string model is requested; modelVersion is resolved; not unknown", async () => {
    // The string has to resolve to a model for ADK, but the gateway reads the
    // field only; an instance named the same way is the same request.
    const agent = new LlmAgent({
      name: "l",
      model: new NamedLlm("gpt-5.5", reply("gpt-5.5-2026-01")),
    });
    const result = await run(agent);
    expect(result.models).toEqual({
      requested: ["gpt-5.5"],
      resolved: ["gpt-5.5-2026-01"],
      unknown: false,
    });
  });

  test("a model instance is requested by its model id", async () => {
    const result = await run(
      new LlmAgent({ name: "l", model: new NamedLlm("inst-1", reply()) }),
    );
    expect(result.models).toEqual({
      requested: ["inst-1"],
      resolved: [],
      unknown: false,
    });
  });

  test("an inherited model is named as requested and the step is unknown", async () => {
    const child = new LlmAgent({ name: "child" });
    new LlmAgent({
      name: "parent",
      model: new NamedLlm("parent-model", reply()),
      subAgents: [child],
    });
    // The child has no model: ADK would use the parent's.
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => child,
    });
    const result = await gateway.run({
      agentName: "child",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new RootAgent()),
    });
    expect(result.models?.requested).toEqual(["parent-model"]);
    expect(result.models?.unknown).toBe(true);
  });

  test("an LlmAgent whose model cannot be read has no requested and is unknown", async () => {
    const orphan = new LlmAgent({ name: "orphan" });
    const result = await run(orphan);
    expect(result.models?.requested).toEqual([]);
    expect(result.models?.unknown).toBe(true);
  });
});

describe("gateway models: other agents and nesting", () => {
  test("an agent with no model information has no models", async () => {
    const trace = new Trace();
    const plain = new ScriptAgent("plain", trace, async function* (context) {
      yield createEvent({
        invocationId: context.invocationId,
        author: "plain",
        content: { role: "model", parts: [{ text: "hi" }] },
      });
    });
    const result = await run(plain);
    expect(result.models).toBeUndefined();
    expect("models" in result).toBe(false);
  });

  test("nested runs are collected in order, without duplicates", async () => {
    const first = external(
      "first",
      { model: "a", reportsResolvedModel: true },
      [
        started("a-full"),
        { type: "output", content: "one" },
        { type: "completed", exitCode: 0 },
      ],
    );
    const second = external(
      "second",
      { model: "b", reportsResolvedModel: true },
      [
        started("b-full"),
        { type: "output", content: "two" },
        { type: "completed", exitCode: 0 },
      ],
    );
    const again = external(
      "third",
      { model: "a", reportsResolvedModel: true },
      [
        started("a-full"),
        { type: "output", content: "three" },
        { type: "completed", exitCode: 0 },
      ],
    );
    const queued: Event[] = [];
    const outer = new ScriptAgent("outer", new Trace(), async function* (c) {
      const gateway = new AgentInvocationGateway({
        resolveAgent: (name) =>
          [first, second, again].find((agent) => agent.name === name),
      });
      for (const name of ["first", "second", "third"]) {
        await gateway.run({
          agentName: name,
          input: { role: "user", parts: [{ text: "go" }] },
          parentContext: c,
          eventSink: (event) => {
            queued.push(event);
          },
        });
      }
      for (const event of queued) yield event;
    });
    const result = await run(outer);
    expect(result.models).toEqual({
      requested: ["a", "b"],
      resolved: ["a-full", "b-full"],
      unknown: false,
    });
  });

  test("a partial event's model is not counted", async () => {
    const partial = new ScriptAgent("p", new Trace(), async function* (c) {
      yield createEvent({
        invocationId: c.invocationId,
        author: "p",
        partial: true,
        content: { role: "model", parts: [{ text: "x" }] },
        modelVersion: "partial-only",
      });
    });
    const result = await run(partial);
    expect(result.models).toBeUndefined();
  });

  test("each malformed externalAgentModel on its own is ignored", async () => {
    const malformed: unknown[] = [
      { requested: 5, status: "unsupported" },
      { requested: "", status: "unsupported" },
      { resolved: "", status: "reported" },
      { resolved: 7, status: "reported" },
      { status: "reported" },
      { status: "unsupported", resolved: "x" },
      { status: "not-reported", resolved: "x" },
      { status: "ok" },
      { requested: "m" },
      ["unsupported"],
      "reported",
      null,
    ];
    for (const value of malformed) {
      const bad = new ScriptAgent("bad", new Trace(), async function* (c) {
        yield createEvent({
          invocationId: c.invocationId,
          author: "bad",
          content: { role: "model", parts: [{ text: "x" }] },
          customMetadata: { externalAgentModel: value },
        });
      });
      const result = await run(bad);
      expect(result.models, JSON.stringify(value)).toBeUndefined();
    }
  });

  test("the agent's own requested id comes before the ids of its nested runs", async () => {
    class DuckExternal extends ScriptAgent {
      readonly driver = { providerId: "duck", model: "own" };
    }
    const outer = new DuckExternal("outer", new Trace(), async function* (c) {
      yield createEvent({
        invocationId: c.invocationId,
        author: "outer",
        content: { role: "model", parts: [{ text: "x" }] },
        customMetadata: {
          externalAgentModel: {
            requested: "inner",
            resolved: "inner-full",
            status: "reported",
          },
        },
      });
    });
    const result = await run(outer);
    expect(result.models).toEqual({
      requested: ["own", "inner"],
      resolved: ["inner-full"],
      unknown: false,
    });
  });
});

/** A composite that runs its sub-agents in order, as ADK's SequentialAgent does. */
class Composite extends BaseAgent {
  constructor(subAgents: BaseAgent[]) {
    super({ name: "composite", subAgents });
  }
  protected async *runAsyncImpl(context: InvocationContext) {
    for (const sub of this.subAgents) yield* sub.runAsync(context);
  }
  protected async *runLiveImpl() {}
}

/** An agent with sub-agents whose run is a script. */
class ScriptedTree extends BaseAgent {
  constructor(
    name: string,
    subAgents: BaseAgent[],
    private readonly script: (
      context: InvocationContext,
    ) => AsyncGenerator<Event, void>,
  ) {
    super({ name, subAgents });
  }
  protected async *runAsyncImpl(context: InvocationContext) {
    yield* this.script(context);
  }
  protected async *runLiveImpl() {}
}

describe("gateway models: agents nested inside the step's agent", () => {
  test("a SequentialAgent of LlmAgents names each child's model", async () => {
    const first = new LlmAgent({
      name: "first",
      model: new NamedLlm("child-model", reply()),
    });
    const second = new LlmAgent({
      name: "second",
      model: new NamedLlm("parent-model", reply()),
    });
    const result = await run(
      new SequentialAgent({ name: "seq", subAgents: [first, second] }),
    );
    expect(result.models).toEqual({
      requested: ["child-model", "parent-model"],
      resolved: [],
      unknown: false,
    });
  });

  test("a nested external agent that ended without completed is named and the step is unknown", async () => {
    const good = external("good", { model: "a", reportsResolvedModel: true }, [
      started("a-full"),
      { type: "output", content: "one" },
      { type: "completed", exitCode: 0 },
    ]);
    const cut = external("cut", { model: "b", reportsResolvedModel: true }, [
      { type: "output", content: "two" },
    ]);
    const result = await run(new Composite([good, cut]));
    expect(result.models).toEqual({
      requested: ["a", "b"],
      resolved: ["a-full"],
      unknown: true,
    });
  });

  test("an inheriting LlmAgent below the agent names the inherited id and the step is unknown", async () => {
    const child = new LlmAgent({ name: "child" });
    const parent = new LlmAgent({
      name: "parent",
      model: new NamedLlm("parent-model", reply()),
      subAgents: [child],
    });
    // As if `child` had run by transfer: an event authored by it.
    const tree = new ScriptedTree("tree", [parent], async function* (c) {
      yield createEvent({
        invocationId: c.invocationId,
        author: "child",
        content: { role: "model", parts: [{ text: "hi" }] },
      });
    });
    const result = await run(tree);
    expect(result.models?.requested).toEqual(["parent-model"]);
    expect(result.models?.unknown).toBe(true);
  });

  test("an event whose author is in no tree and carries no model info makes the step unknown", async () => {
    const result = await run(
      new ScriptAgent("outer", new Trace(), async function* (c) {
        yield createEvent({
          invocationId: c.invocationId,
          author: "stranger",
          content: { role: "model", parts: [{ text: "hi" }] },
        });
      }),
    );
    expect(result.models).toEqual({
      requested: [],
      resolved: [],
      unknown: true,
    });
  });

  test("an event authored by the user does not make the step unknown", async () => {
    const result = await run(
      new ScriptAgent("outer", new Trace(), async function* (c) {
        yield createEvent({
          invocationId: c.invocationId,
          author: "user",
          content: { role: "user", parts: [{ text: "hi" }] },
        });
      }),
    );
    expect(result.models).toBeUndefined();
  });

  test("a stranger's event with a well-formed external model info is described by that info", async () => {
    const result = await run(
      new ScriptAgent("outer", new Trace(), async function* (c) {
        yield createEvent({
          invocationId: c.invocationId,
          author: "stranger",
          content: { role: "model", parts: [{ text: "hi" }] },
          customMetadata: {
            externalAgentModel: {
              requested: "x",
              resolved: "x-full",
              status: "reported",
            },
          },
        });
      }),
    );
    expect(result.models).toEqual({
      requested: ["x"],
      resolved: ["x-full"],
      unknown: false,
    });
  });
});
