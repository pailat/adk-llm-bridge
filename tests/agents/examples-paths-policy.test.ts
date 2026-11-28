/**
 * The shipped Codex examples must pass the drivers' pre-start path refusal
 * (`EXTERNAL_AGENT_PATHS_UNENFORCEABLE`) with the permissions they really run
 * with. Each driver's SDK loader is stubbed, so no Codex SDK or binary starts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveSubAgentPermissionPolicy,
  EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
  type ExternalAgentEvent,
  type ExternalAgentPermissionPolicy,
} from "../../src/agents/index.js";
import { withHermeticCodexEnv } from "../helpers/env.js";
import { resolveBridgeToSource } from "../helpers/example-modules.js";

resolveBridgeToSource();

// Paths in variables keep tsc from type-checking the examples, which are
// standalone projects; their `adk-llm-bridge` imports load `src/`.
const BASIC_CODEX = "../../examples/basic-agent-codex/agent.ts";
const CODEX_WORKFLOW = "../../examples/codex-workflow/agent.ts";
const EXTERNAL_AGENTS = "../../examples/external-agents/agent.ts";

/** Variables the examples read when they are imported or build agents. */
const EXAMPLE_ENV_KEYS = [
  "ARCHITECTURE_ANALYSIS_PATHS",
  "WORKFLOW_TARGET",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "CLAUDE_CODE_EXECUTABLE",
  "CLAUDE_CODE_PATH",
  "SMOKE_PROMPT",
] as const;

/**
 * Runs a whole test (example import, agent construction and driver run) on a
 * temp HOME/CODEX_HOME, an empty PATH and none of the Codex or example
 * variables, so a developer machine sees what CI sees. The examples still
 * read `process.cwd()`, which is the repository root in both.
 */
function hermetic(fn: () => Promise<void>): Promise<void> {
  return withHermeticCodexEnv(fn, { unset: EXAMPLE_ENV_KEYS });
}

interface ExampleAgent {
  name: string;
  permissions?: ExternalAgentPermissionPolicy;
  driver: {
    run(request: unknown): AsyncIterable<ExternalAgentEvent>;
  };
}

class SdkNotLoaded extends Error {}

/**
 * Runs the driver up to the point where it would load the Codex SDK and
 * reports whether it got there, plus any error code it emitted first.
 */
async function preStart(
  agent: ExampleAgent,
  permissions: ExternalAgentPermissionPolicy | undefined,
): Promise<{ reachedSdk: boolean; codes: unknown[] }> {
  let reachedSdk = false;
  const driver = agent.driver as unknown as Record<string, unknown>;
  driver.loadConstructor = async () => {
    reachedSdk = true;
    throw new SdkNotLoaded("stub: the test never loads the Codex SDK");
  };
  const codes: unknown[] = [];
  for await (const event of agent.driver.run({
    permissions,
    instruction: "",
    messages: [],
    context: {},
  })) {
    if (event.type === "error") codes.push(event.code);
  }
  return { reachedSdk, codes };
}

function expectNoPathRefusal(result: {
  reachedSdk: boolean;
  codes: unknown[];
}): void {
  expect(result.codes).not.toContain(EXTERNAL_AGENT_PATHS_UNENFORCEABLE);
  expect(result.reachedSdk).toBe(true);
}

describe("shipped Codex examples are not refused for their paths", () => {
  test("basic-agent-codex", async () => {
    await hermetic(async () => {
      const { rootAgent } = (await import(BASIC_CODEX)) as {
        rootAgent: ExampleAgent;
      };

      expectNoPathRefusal(await preStart(rootAgent, rootAgent.permissions));
    });
  });

  test("codex-workflow planner, implementer and reviewer", async () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), "codex-wf-")));
    try {
      await hermetic(async () => {
        const { createWorkflow } = (await import(CODEX_WORKFLOW)) as {
          createWorkflow(target: string): { subAgents: ExampleAgent[] };
        };
        const steps = createWorkflow(target).subAgents;

        expect(steps.map((step) => step.name)).toEqual([
          "CodexPlanner",
          "CodexImplementer",
          "CodexReviewer",
        ]);
        for (const step of steps) {
          expectNoPathRefusal(await preStart(step, step.permissions));
        }
      });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("external-agents Codex sub-agent with the bounds it inherits from the Claude root", async () => {
    // A developer's shell may set this; an invalid entry throws on import.
    const saved = process.env.ARCHITECTURE_ANALYSIS_PATHS;
    process.env.ARCHITECTURE_ANALYSIS_PATHS = "acme/relative-is-invalid";
    try {
      await hermetic(async () => {
        const { rootAgent } = (await import(EXTERNAL_AGENTS)) as {
          rootAgent: ExampleAgent & { subAgents: ExampleAgent[] };
        };
        const codex = rootAgent.subAgents.find(
          (agent) => agent.name === "CodexBillingSpecialist",
        );
        if (!codex) throw new Error("CodexBillingSpecialist not found");
        const effective = deriveSubAgentPermissionPolicy(
          rootAgent.permissions,
          codex.permissions,
        );

        expect(effective.pathBounds?.length).toBeGreaterThan(0);
        expectNoPathRefusal(await preStart(codex, effective));
      });
    } finally {
      if (saved === undefined) delete process.env.ARCHITECTURE_ANALYSIS_PATHS;
      else process.env.ARCHITECTURE_ANALYSIS_PATHS = saved;
    }
  });
});
