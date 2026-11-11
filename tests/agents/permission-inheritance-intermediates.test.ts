import { describe, expect } from "bun:test";
import {
  AgentTool,
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  InMemorySessionService,
  type InvocationContext,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  NodeTool,
  PluginManager,
  Runner,
  Workflow,
} from "@google/adk";
import { z } from "zod";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentRunRequest,
  ToolGateway,
} from "../../src/agents/index.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import {
  defineScriptWorkflow,
  defineWorkflow,
} from "../../src/workflows/definition.js";
import {
  WORKFLOW_SCRIPT_PROTOCOL,
  WORKFLOW_SCRIPT_PROTOCOL_VERSION,
} from "../../src/workflows/sandbox/protocol.js";
import { QUICKJS_SYNC_CAPABILITIES } from "../../src/workflows/sandbox/quickjs-generator-runtime.js";
import type {
  WorkflowScriptGeneratorSession,
  WorkflowScriptGeneratorTurn,
  WorkflowScriptRuntime,
  WorkflowScriptSessionOptions,
} from "../../src/workflows/sandbox/types.js";
import { ScriptWorkflowAgent } from "../../src/workflows/script-workflow-agent.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";
import { fromPartial } from "../helpers/partial.js";
// Every test here gets a deadline and the host-blocking watchdog.
import { sandboxTest as test } from "../helpers/sandbox-test.js";

/**
 * Regression tests for permission inheritance across the intermediates that
 * create their own sessions or contexts: our workflow agents (a new child
 * session per step), ADK `Workflow` as a tool node, and `AgentTool` (known
 * limitation, pinned here).
 */

const FULL = { mode: "full-access", allowNetwork: true } as const;
const READ_ONLY = { mode: "read-only", allowNetwork: false } as const;

class CaptureDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  request?: ExternalAgentRunRequest;

  async *run(request: ExternalAgentRunRequest) {
    this.request = request;
    yield { type: "output" as const, content: "child" };
  }
}

class Root extends BaseAgent {
  constructor() {
    super({ name: "root" });
  }
  protected async *runAsyncImpl() {}
  protected async *runLiveImpl() {}
}

function worker(
  driver: ExternalAgentDriver,
  name = "worker",
  permissions: ExternalAgentPermissionPolicy = FULL,
  subAgents: BaseAgent[] = [],
) {
  return new ExternalAgent({
    name,
    provider: CODEX_PROVIDER,
    driver,
    permissions,
    subAgents,
  });
}

function parentContext(agent: BaseAgent): InvocationContext {
  return fromPartial<InvocationContext>({
    invocationId: "inv-1",
    agent,
    userContent: { role: "user", parts: [{ text: "parent" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
    pluginManager: new PluginManager(),
  });
}

async function delegate(
  target: BaseAgent,
  parentPermissions: ExternalAgentPermissionPolicy = { mode: "read-only" },
) {
  const root = new Root();
  const gateway = new ToolGateway({
    rootAgent: root,
    subAgents: [target],
    parentContext: parentContext(root),
    parentPermissions,
  });
  const result = await gateway.runSubAgent({
    agentName: target.name,
    task: "go",
  });
  expect(result.error).toBeUndefined();
}

class ScriptedRuntime implements WorkflowScriptRuntime {
  readonly capabilities = QUICKJS_SYNC_CAPABILITIES;

  constructor(
    private readonly factory: (
      options: WorkflowScriptSessionOptions,
    ) => Generator<unknown, unknown, unknown>,
  ) {}

  async createSession(
    options: WorkflowScriptSessionOptions,
  ): Promise<WorkflowScriptGeneratorSession> {
    const generator = this.factory(options);
    let disposed = false;
    return {
      get disposed() {
        return disposed;
      },
      // A generator always sets `done`; the lib type marks it optional on yields.
      next: (value) => generator.next(value) as WorkflowScriptGeneratorTurn,
      dispose() {
        disposed = true;
        generator.return(undefined);
      },
    };
  }
}

/** Per-agent store so nested workflow agents do not share session-state checkpoints. */
class MemoryCheckpointStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;

  async load() {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    return {
      checkpointKey: `memory:${input.checkpoint.executionId}`,
      // Kept out of session state so nested agents do not share it.
      stateDelta: {},
    };
  }
}

function scriptRun(agentName: string) {
  return function* () {
    const result = (yield {
      protocol: WORKFLOW_SCRIPT_PROTOCOL,
      version: WORKFLOW_SCRIPT_PROTOCOL_VERSION,
      op: "run",
      step: { id: `step-${agentName}`, agentName, input: "go" },
    }) as { output: string };
    return result.output;
  };
}

function oneCallLlm(toolName: string, args: Record<string, unknown>) {
  let calls = 0;
  return new (class extends BaseLlm {
    constructor() {
      super({ model: `fake-${toolName}` });
    }
    async *generateContentAsync(
      _request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void> {
      calls++;
      yield calls === 1
        ? {
            content: {
              role: "model",
              parts: [{ functionCall: { id: "c1", name: toolName, args } }],
            },
          }
        : { content: { role: "model", parts: [{ text: "done" }] } };
    }
    async connect(): Promise<BaseLlmConnection> {
      throw new Error("not implemented");
    }
  })();
}

describe("permission inheritance through our workflow agents", () => {
  // A root WorkflowAgent is not a security principal and applies no ceiling:
  // each step runs with its own policy, and network is off unless that policy
  // sets allowNetwork: true.
  test("under a root WorkflowAgent an unset allowNetwork means false", async () => {
    const open = new CaptureDriver();
    const unset = new CaptureDriver();
    const workflow = new WorkflowAgent({
      name: "root_workflow",
      subAgents: [
        worker(open, "open", { mode: "workspace-write", allowNetwork: true }),
        worker(unset, "unset", { mode: "workspace-write" }),
      ],
      definition: defineWorkflow({
        id: "root",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "a", agentName: "open", input: ctx.input });
          await ctx.run({ id: "b", agentName: "unset", input: ctx.input });
          return "done";
        },
      }),
    });
    const sessions = new InMemorySessionService();
    const runner = new Runner({
      appName: "root-ceiling",
      agent: workflow,
      sessionService: sessions,
    });
    const session = await sessions.createSession({
      appName: "root-ceiling",
      userId: "user",
    });
    for await (const _ of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "go" }] },
    })) {
      // drain
    }

    // An explicit opt-in on the step still keeps the network.
    expect(open.request?.permissions).toEqual({
      mode: "workspace-write",
      allowNetwork: true,
    });
    expect(unset.request?.permissions).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
    });
  });

  test("WorkflowAgent step does not escalate", async () => {
    const driver = new CaptureDriver();
    const workflow = new WorkflowAgent({
      name: "durable",
      subAgents: [worker(driver)],
      definition: defineWorkflow({
        id: "d",
        version: "1",
        handler: async (ctx) =>
          (await ctx.run({ id: "s", agentName: "worker", input: ctx.input }))
            .output,
      }),
    });

    await delegate(workflow);

    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("ScriptWorkflowAgent step does not escalate", async () => {
    const driver = new CaptureDriver();
    const workflow = new ScriptWorkflowAgent({
      name: "script",
      subAgents: [worker(driver)],
      definition: defineScriptWorkflow({
        id: "s",
        version: "1",
        source: "/* executed by the injected runtime */",
      }),
      runtime: new ScriptedRuntime(scriptRun("worker")),
    });

    await delegate(workflow);

    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("a two-level workflow chain does not escalate", async () => {
    const driver = new CaptureDriver();
    const inner = new WorkflowAgent({
      name: "inner",
      resolveExecutionId: () => "exec-inner",
      checkpointStore: new MemoryCheckpointStore(),
      subAgents: [worker(driver)],
      definition: defineWorkflow({
        id: "inner",
        version: "1",
        handler: async (ctx) =>
          (await ctx.run({ id: "i", agentName: "worker", input: ctx.input }))
            .output,
      }),
    });
    const outer = new WorkflowAgent({
      name: "outer",
      resolveExecutionId: () => "exec-outer",
      checkpointStore: new MemoryCheckpointStore(),
      subAgents: [inner],
      definition: defineWorkflow({
        id: "outer",
        version: "1",
        handler: async (ctx) =>
          (await ctx.run({ id: "o", agentName: "inner", input: ctx.input }))
            .output,
      }),
    });

    await delegate(outer);

    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });
});

describe("permission inheritance through ADK intermediates", () => {
  test("ADK Workflow run as a NodeTool does not escalate", async () => {
    const driver = new CaptureDriver();
    const workflow = new Workflow({
      name: "wf",
      inputSchema: z.object({ request: z.string() }),
      edges: [["START", worker(driver)]],
    } as never);
    const coordinator = new LlmAgent({
      name: "coordinator",
      model: oneCallLlm("wf", { request: "x" }),
      tools: [new NodeTool(workflow, "wf")],
    });

    await delegate(coordinator);

    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("known limitation: AgentTool restarts the chain (new session)", async () => {
    const driver = new CaptureDriver();
    const coordinator = new LlmAgent({
      name: "coordinator",
      model: oneCallLlm("worker", { request: "x" }),
      tools: [new AgentTool({ agent: worker(driver) })],
    });

    await delegate(coordinator);

    // Documented in permissions/inheritance.ts and the CHANGELOG: inheritance
    // does not cross AgentTool. If ADK ever links the sessions this assertion
    // should be tightened to READ_ONLY.
    expect(driver.request?.permissions).toEqual(FULL);
  });
});
