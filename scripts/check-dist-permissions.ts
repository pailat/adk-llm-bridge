/**
 * Post-build smoke check: permission inheritance must hold across the
 * published entry points, not only from `src/`.
 *
 * bunup builds each entry point as a separate bundle (`splitting: false`), so
 * shared modules are duplicated in `dist/agents` and `dist/workflows`. A
 * read-only parent that delegates to a `WorkflowAgent` (from
 * `adk-llm-bridge/workflows`) must still constrain a nested `full-access`
 * `ExternalAgent` (from `adk-llm-bridge/agents`).
 *
 * Usage: `bun run build && bun scripts/check-dist-permissions.ts`
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BaseAgent,
  type InvocationContext,
  LogLevel,
  PluginManager,
  setLogLevel,
} from "@google/adk";

const distDir = process.env.DIST_DIR ?? resolve(import.meta.dir, "..", "dist");
const load = (entry: string) =>
  import(pathToFileURL(resolve(distDir, entry, "index.js")).href);

const agents = await load("agents");
const workflows = await load("workflows");
setLogLevel(LogLevel.ERROR);

const { ExternalAgent, ToolGateway, CODEX_PROVIDER } = agents;
const { WorkflowAgent, defineWorkflow } = workflows;

interface CapturedRequest {
  permissions?: { mode?: string; allowNetwork?: boolean };
}

class CapturingDriver {
  readonly providerId = CODEX_PROVIDER.id;
  request: CapturedRequest | undefined;
  async *run(request: CapturedRequest) {
    this.request = request;
    yield { type: "output", content: "child" };
  }
}

class RootAgent extends BaseAgent {
  constructor() {
    super({ name: "root" });
  }
  protected async *runAsyncImpl() {}
  protected async *runLiveImpl() {}
}

const root = new RootAgent();
const parentContext = {
  invocationId: "inv-dist-check",
  agent: root,
  userContent: { role: "user", parts: [{ text: "start" }] },
  session: {
    id: "session-dist-check",
    appName: "dist-check",
    userId: "user",
    state: {},
    events: [],
    lastUpdateTime: 1,
  },
  pluginManager: new PluginManager(),
} as unknown as InvocationContext;

const driver = new CapturingDriver();
const worker = new ExternalAgent({
  name: "worker",
  provider: CODEX_PROVIDER,
  driver,
  permissions: { mode: "full-access", allowNetwork: true },
});
const durable = new WorkflowAgent({
  name: "durable",
  subAgents: [worker],
  definition: defineWorkflow({
    id: "dist-check",
    version: "1",
    handler: async (ctx: {
      input: unknown;
      run: (step: object) => Promise<{ output: unknown }>;
    }) =>
      (await ctx.run({ id: "step", agentName: "worker", input: ctx.input }))
        .output,
  }),
});
const gateway = new ToolGateway({
  rootAgent: root,
  subAgents: [durable],
  parentContext,
  parentPermissions: { mode: "read-only" },
});

const result = await gateway.runSubAgent({ agentName: "durable", task: "go" });
const effective = driver.request?.permissions;

if (!driver.request) {
  console.error("check-dist-permissions: nested agent did not run", result);
  process.exit(1);
}
if (effective?.mode !== "read-only" || effective.allowNetwork === true) {
  console.error(
    "check-dist-permissions: FAIL, nested ExternalAgent escaped the parent policy:",
    JSON.stringify(effective),
  );
  process.exit(1);
}
console.log(
  "check-dist-permissions: OK (nested agent runs as",
  `${JSON.stringify(effective)})`,
);
