import { describe, expect, test } from "bun:test";
import { BaseAgent, type InvocationContext, PluginManager } from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentRunRequest,
  ToolGateway,
} from "../../src/agents/index.js";
import {
  getInheritedPermissions,
  inheritSessionPermissions,
  resolveEffectivePermissions,
  setInheritedPermissions,
} from "../../src/agents/permissions/inheritance.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { fromPartial } from "../helpers/partial.js";

/**
 * A child's own relative `allowedPaths` survive a delegation from a parent
 * that sets none, although the policy is derived twice (by the gateway when it
 * delegates, then by the child when it runs). Every other case still drops a
 * relative root.
 */

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
  permissions: ExternalAgentPermissionPolicy,
  name = "worker",
) {
  return new ExternalAgent({
    name,
    provider: CODEX_PROVIDER,
    driver,
    permissions,
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
  parentPermissions: ExternalAgentPermissionPolicy,
  root: BaseAgent = new Root(),
  context: InvocationContext = parentContext(root),
) {
  const gateway = new ToolGateway({
    rootAgent: root,
    subAgents: [target],
    parentContext: context,
    parentPermissions,
  });
  const result = await gateway.runSubAgent({
    agentName: target.name,
    task: "go",
  });
  expect(result.error).toBeUndefined();
}

describe("a child's relative allowedPaths through a delegation", () => {
  test("stay when the parent sets no allowedPaths", async () => {
    const driver = new CaptureDriver();
    await delegate(
      worker(driver, { mode: "workspace-write", allowedPaths: ["src"] }),
      { mode: "workspace-write" },
    );
    expect(driver.request?.permissions).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
      allowedPaths: ["src"],
    });
  });

  test("keep the child's anchored roots next to its relative ones", async () => {
    const driver = new CaptureDriver();
    await delegate(
      worker(driver, {
        mode: "workspace-write",
        allowedPaths: ["src", "/tmp/shared"],
      }),
      { mode: "full-access", allowNetwork: true },
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual([
      "src",
      "/tmp/shared",
    ]);
    expect(driver.request?.permissions?.pathBounds).toBeUndefined();
  });

  test("keep a parent's pathBounds set without allowedPaths", async () => {
    const driver = new CaptureDriver();
    await delegate(
      worker(driver, { mode: "workspace-write", allowedPaths: ["src"] }),
      { mode: "workspace-write", pathBounds: [["/tmp"]] },
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual(["src"]);
    expect(driver.request?.permissions?.pathBounds).toEqual([["/tmp"]]);
  });

  test("keep the child's own pathBounds next to the parent's", async () => {
    const driver = new CaptureDriver();
    await delegate(
      worker(driver, {
        mode: "workspace-write",
        allowedPaths: ["src"],
        pathBounds: [["/tmp/c"]],
      }),
      { mode: "workspace-write", pathBounds: [["/tmp"]] },
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual(["src"]);
    expect(driver.request?.permissions?.pathBounds).toEqual([
      ["/tmp"],
      ["/tmp/c"],
      ["/tmp/c"],
    ]);
  });

  test("are still dropped when the parent sets anchored roots", async () => {
    const driver = new CaptureDriver();
    await delegate(
      worker(driver, { mode: "workspace-write", allowedPaths: ["src"] }),
      { mode: "workspace-write", allowedPaths: ["/tmp"] },
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual([]);
  });

  test("keep the parent's bounds when the parent sets anchored roots", async () => {
    const driver = new CaptureDriver();
    await delegate(
      worker(driver, {
        mode: "workspace-write",
        allowedPaths: ["src", "/tmp/a"],
      }),
      { mode: "workspace-write", allowedPaths: ["/tmp"] },
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual(["/tmp/a"]);
    expect(driver.request?.permissions?.pathBounds).toEqual([
      ["/tmp"],
      ["/tmp/a"],
      ["/tmp/a"],
      ["/tmp/a"],
    ]);
  });

  test("are still dropped when the parent sets the same relative root", async () => {
    const driver = new CaptureDriver();
    await delegate(
      worker(driver, { mode: "workspace-write", allowedPaths: ["src"] }),
      { mode: "workspace-write", allowedPaths: ["src"] },
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual([]);
  });

  test("are dropped when the session already carries the parent's own relative roots", async () => {
    const driver = new CaptureDriver();
    const root = new Root();
    const context = parentContext(root);
    // The coordinator itself runs delegated, with its own relative root.
    setInheritedPermissions(context.session, {
      mode: "workspace-write",
      allowNetwork: false,
      allowedPaths: ["src"],
    });
    await delegate(
      worker(driver, { mode: "workspace-write", allowedPaths: ["src"] }),
      { mode: "workspace-write" },
      root,
      context,
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual([]);
  });

  test("are bounded by roots the session already carries", async () => {
    const driver = new CaptureDriver();
    const root = new Root();
    const context = parentContext(root);
    setInheritedPermissions(context.session, {
      mode: "workspace-write",
      allowNetwork: false,
      allowedPaths: ["/tmp"],
    });
    await delegate(
      worker(driver, {
        mode: "workspace-write",
        allowedPaths: ["src", "/tmp/a"],
      }),
      { mode: "workspace-write" },
      root,
      context,
    );
    expect(driver.request?.permissions?.allowedPaths).toEqual(["/tmp/a"]);
    expect(driver.request?.permissions?.pathBounds).toEqual([
      ["/tmp"],
      ["/tmp/a"],
      ["/tmp/a"],
      ["/tmp/a"],
    ]);
  });
});

describe("the delegated child's own roots are not reusable", () => {
  const childPolicy: ExternalAgentPermissionPolicy = {
    mode: "workspace-write",
    allowedPaths: ["src"],
  };

  async function delegatedSession() {
    let session: object | undefined;
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run() {
        yield { type: "output" as const, content: "child" };
      },
    };
    const agent = worker(driver, childPolicy);
    const original = agent.runAsync.bind(agent);
    agent.runAsync = (context: InvocationContext) => {
      session = context.session;
      return original(context);
    };
    await delegate(agent, { mode: "workspace-write" });
    if (!session) throw new Error("the child did not run");
    return { agent, session };
  }

  test("by another agent reading the same session", async () => {
    const { session } = await delegatedSession();
    const other = worker(new CaptureDriver(), childPolicy, "other");
    expect(
      resolveEffectivePermissions(session, childPolicy, other)?.allowedPaths,
    ).toEqual([]);
    expect(
      resolveEffectivePermissions(session, childPolicy)?.allowedPaths,
    ).toEqual([]);
  });

  test("by the same agent after the session is narrowed again", async () => {
    const { agent, session } = await delegatedSession();
    expect(
      resolveEffectivePermissions(session, childPolicy, agent)?.allowedPaths,
    ).toEqual(["src"]);
    setInheritedPermissions(session, { mode: "workspace-write" });
    expect(
      resolveEffectivePermissions(session, childPolicy, agent)?.allowedPaths,
    ).toEqual([]);
  });

  test("by the same agent for bounds after the session is narrowed again", async () => {
    let session: object | undefined;
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: ["/tmp/a"],
    };
    const agent = worker(new CaptureDriver(), policy);
    const original = agent.runAsync.bind(agent);
    agent.runAsync = (context: InvocationContext) => {
      session = context.session;
      return original(context);
    };
    await delegate(agent, { mode: "workspace-write" });
    if (!session) throw new Error("the child did not run");
    setInheritedPermissions(session, {
      mode: "workspace-write",
      allowedPaths: ["/tmp"],
    });
    expect(resolveEffectivePermissions(session, policy, agent)).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
      allowedPaths: ["/tmp/a"],
      pathBounds: [["/tmp/a"], ["/tmp"], ["/tmp/a"], ["/tmp/a"]],
    });
  });

  test("by a new session that inherits from the delegated one", async () => {
    const { agent, session } = await delegatedSession();
    const step = {};
    inheritSessionPermissions(session, step);
    expect(getInheritedPermissions(step)?.allowedPaths).toEqual(["src"]);
    expect(
      resolveEffectivePermissions(step, childPolicy, agent)?.allowedPaths,
    ).toEqual([]);
  });

  test("by the same agent asking for roots it was not delegated with", async () => {
    const { agent, session } = await delegatedSession();
    expect(
      resolveEffectivePermissions(
        session,
        { mode: "workspace-write", allowedPaths: ["src", "lib"] },
        agent,
      )?.allowedPaths,
    ).toEqual(["src"]);
    expect(
      resolveEffectivePermissions(session, { mode: "workspace-write" }, agent)
        ?.allowedPaths,
    ).toEqual([]);
  });
});
