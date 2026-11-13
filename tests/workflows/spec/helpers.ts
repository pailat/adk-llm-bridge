import {
  DEFAULT_DENIED_PATH_PATTERNS,
  type RunRules,
  type RunSpec,
  type RunSpecLane,
} from "../../../src/workflows/spec/schema.js";

/**
 * A fresh valid run spec for a small job: one lane changes the API and a
 * second lane, which waits for it, updates the docs.
 *
 * @remarks
 * Every call returns a new object, so a test can change its copy freely.
 * {@link testRules} accepts it.
 */
export function validSpec(): RunSpec {
  return {
    specVersion: 1,
    workflowId: "lanes",
    workflowVersion: "1",
    projectRoot: ".",
    budget: { maxUsd: 5 },
    maxConcurrency: 2,
    lanes: [
      {
        taskId: "api",
        title: "Add the health endpoint",
        role: "worker",
        dependsOn: [],
        allowedPaths: ["src/api", "tests/api"],
        agent: {
          providerId: "claude-code",
          model: "claude-sonnet-5",
          mode: "workspace-write",
          tools: ["Read", "Edit"],
        },
        steps: {
          testsFirst: true,
          review: {
            kind: "agent",
            providerId: "codex",
            model: "gpt-5.5",
            maxChangeRounds: 2,
          },
        },
      },
      {
        taskId: "docs",
        title: "Document the health endpoint",
        role: "worker",
        dependsOn: ["api"],
        allowedPaths: ["docs/api.md"],
        agent: {
          providerId: "codex",
          model: "gpt-5.5",
          mode: "workspace-write",
          allowNetwork: false,
          tools: [],
        },
        steps: { testsFirst: false, review: { kind: "none" } },
      },
    ],
    gates: {
      qa: [{ id: "test", command: ["bun", "run", "test"] }],
      publish: { kind: "commit", hitl: true },
    },
    env: ["CI"],
  };
}

/**
 * A fresh rule set that accepts {@link validSpec} with room to spare on
 * every cap, so a test can break one rule at a time.
 */
export function testRules(): RunRules {
  return {
    id: "test",
    maxBudgetUsd: 10,
    maxConcurrency: 4,
    maxLanes: 1_000,
    maxStringLength: 4_096,
    maxArrayLength: 64,
    maxChangeRounds: 3,
    maxAgentRuns: 10_000,
    allowedProviderIds: ["claude-code", "codex"],
    allowedModels: ["claude-sonnet-5", "gpt-5.5"],
    allowedPermissionModes: ["read-only", "workspace-write"],
    allowNetwork: false,
    allowedTools: ["Read", "Edit", "Bash"],
    allowedEnvNames: ["CI", "NODE_ENV"],
    allowedMcpProviders: [],
    deniedPathPatterns: [...DEFAULT_DENIED_PATH_PATTERNS],
    allowedQaCommands: [
      ["bun", "run", "test"],
      ["bun", "run", "lint"],
    ],
    requireQa: true,
    allowedPublishKinds: ["none", "commit"],
    allowedWorkflows: [{ workflowId: "lanes", workflowVersion: "1" }],
    allowedTargetRefs: ["refs/heads/main"],
  };
}

/**
 * A valid spec with `count` lanes, for size and time tests.
 *
 * @remarks
 * Lane `n` owns `src/lane-n` and waits for the lane ten places before it, so
 * the spec has ten lanes per wave. It is valid under {@link testRules} for
 * any count up to 1,000.
 *
 * @param count - Number of lanes, at least 1.
 */
export function wideSpec(count: number): RunSpec {
  const spec = validSpec();
  const lanes: RunSpecLane[] = [];
  for (let index = 0; index < count; index++) {
    lanes.push({
      taskId: `lane-${index}`,
      title: `Lane ${index}`,
      role: "worker",
      dependsOn: index >= 10 ? [`lane-${index - 10}`] : [],
      allowedPaths: [`src/lane-${index}`],
      agent: {
        providerId: "codex",
        model: "gpt-5.5",
        mode: "workspace-write",
        tools: [],
      },
      steps: { testsFirst: false, review: { kind: "none" } },
    });
  }
  return { ...spec, lanes };
}
