import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type * as Adk from "@google/adk";
import {
  CodexAgent,
  EnvCredentialProvider,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";
import {
  type WorkflowEvent,
  type WorkflowOutputEvent,
  defineScriptWorkflow,
  ScriptWorkflowAgent,
} from "adk-llm-bridge/workflows";

const adkRuntime = await import(
  new URL(
    [
      "..",
      "..",
      "node_modules",
      "@google",
      "adk",
      "dist",
      "esm",
      "index.js",
    ].join("/"),
    import.meta.url,
  ).href,
);

const HANDOFF_ID = "codex-workflow-smoke-v1";
let workflowOutput = "";

function requireTarget(): string {
  const target = process.env.WORKFLOW_TARGET;
  if (!target || !isAbsolute(target)) {
    throw new Error("WORKFLOW_TARGET must be an absolute disposable worktree path");
  }
  const resolved = realpathSync(target);
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`WORKFLOW_TARGET is not a directory: ${resolved}`);
  }
  return resolved;
}

function hasReadableCodexAuthJson(): boolean {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  try {
    accessSync(join(codexHome, "auth.json"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function codexCredentialsAvailable(): boolean {
  return Boolean(
    process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.CODEX_EXECUTABLE ||
      process.env.CODEX_CLI_PATH ||
      hasReadableCodexAuthJson(),
  );
}

function contentText(content: WorkflowOutputEvent["content"]): string {
  if (typeof content === "string") return content;
  return (content.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

function logWorkflowEvent(event: WorkflowEvent): void {
  if (event.type === "step_completed") {
    console.log(
      `[workflow] ${event.result.id} completed by ${event.result.agentName}`,
    );
  } else if (event.type === "step_replayed") {
    console.log(`[workflow] ${event.result.id} replayed from checkpoint`);
  } else if (event.type === "output") {
    workflowOutput = contentText(event.content);
  } else if (event.type === "workflow_completed") {
    console.log(
      `[workflow] completed ${event.summary.steps} steps (${event.summary.replayedSteps} replayed)`,
    );
  }
}

function createWorkflow(target: string): ScriptWorkflowAgent {
  const credentialProvider = new EnvCredentialProvider();
  const readOnly = {
    ...mapPermissionModeToPolicy("read-only"),
    allowNetwork: false,
    allowedPaths: [target],
  };
  const workspaceWrite = {
    ...mapPermissionModeToPolicy("workspace-write"),
    allowNetwork: false,
    allowedPaths: [target],
  };

  const planner = new CodexAgent({
    name: "CodexPlanner",
    description: "Finds one small, testable repository improvement.",
    credentialProvider,
    workingDirectory: target,
    permissions: readOnly,
    instruction: `Inspect the current repository without changing files. Select exactly one small, low-risk improvement related to workflows, tests, examples, or documentation. It must be independently testable and must not change dependencies, lockfiles, generated dist files, package version, or public API. Return a compact implementation plan. Include the exact line HANDOFF_ID: ${HANDOFF_ID}.`,
  });

  const implementer = new CodexAgent({
    name: "CodexImplementer",
    description: "Applies one bounded improvement selected by the planner.",
    credentialProvider,
    workingDirectory: target,
    permissions: workspaceWrite,
    instruction: `Apply exactly the single low-risk improvement in the supplied planner handoff. Do not commit. Do not change dependencies, lockfiles, generated dist files, package version, or public API. Run the narrowest relevant check. Your response must begin with HANDOFF_ACK: ${HANDOFF_ID} and summarize changed files and validation.`,
  });

  const reviewer = new CodexAgent({
    name: "CodexReviewer",
    description: "Reviews the implementation and its handoff evidence.",
    credentialProvider,
    workingDirectory: target,
    permissions: readOnly,
    instruction: `Review the current git diff against the supplied planner and implementer handoffs. Do not modify files. Verify scope, correctness, and the reported test. Your response must begin with REVIEW_ACK: ${HANDOFF_ID}, followed by PASS or FAIL and concise evidence.`,
  });

  const source = `
    const plan = yield ctx.run({
      id: "plan",
      agentName: "CodexPlanner",
      input: ctx.inputText
    });
    const implementation = yield ctx.run({
      id: "implement",
      agentName: "CodexImplementer",
      input: "HANDOFF_ID: ${HANDOFF_ID}\\n\\nPLANNER OUTPUT:\\n" + plan.output
    });
    const review = yield ctx.run({
      id: "review",
      agentName: "CodexReviewer",
      input: "HANDOFF_ID: ${HANDOFF_ID}\\n\\nPLANNER OUTPUT:\\n" + plan.output +
        "\\n\\nIMPLEMENTER OUTPUT:\\n" + implementation.output
    });
    return JSON.stringify({
      handoffId: "${HANDOFF_ID}",
      plan: plan.output,
      implementation: implementation.output,
      review: review.output
    }, null, 2);
  `;

  return new ScriptWorkflowAgent({
    name: "CodexImprovementWorkflow",
    definition: defineScriptWorkflow({
      id: "codex-improvement-smoke",
      version: "1",
      description: "Planner to implementer to reviewer, using only Codex agents.",
      source,
      limits: {
        maxSteps: 3,
        maxConcurrency: 1,
        maxAttemptsPerStep: 1,
        timeoutMs: 15 * 60 * 1000,
      },
    }),
    subAgents: [planner, implementer, reviewer],
    onEvent: logWorkflowEvent,
  });
}

export async function main(): Promise<void> {
  if (!codexCredentialsAvailable()) {
    console.log(
      "Set CODEX_API_KEY/OPENAI_API_KEY or sign in so ~/.codex/auth.json exists.",
    );
    return;
  }
  if (process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) {
    process.env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
  }

  const target = requireTarget();
  const rootAgent = createWorkflow(target);
  const { InMemorySessionService, Runner } = adkRuntime as typeof Adk;
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: "codex-workflow-smoke",
    userId: "smoke-user",
  });
  const runner = new Runner({
    appName: "codex-workflow-smoke",
    agent: rootAgent,
    sessionService,
  });

  for await (const event of runner.runAsync({
    userId: "smoke-user",
    sessionId: session.id,
    newMessage: {
      role: "user",
      parts: [
        {
          text: "Inspect this worktree and improve it once. Keep the change atomic and low risk.",
        },
      ],
    },
  })) {
    if (event.errorMessage) throw new Error(event.errorMessage);
  }

  if (
    !workflowOutput.includes(`HANDOFF_ACK: ${HANDOFF_ID}`) ||
    !workflowOutput.includes(`REVIEW_ACK: ${HANDOFF_ID}`)
  ) {
    throw new Error("Codex agents did not acknowledge the workflow handoffs");
  }
  console.log("[workflow] verified planner -> implementer -> reviewer handoffs");
  console.log(workflowOutput);
}

if (import.meta.main) {
  await main();
}
