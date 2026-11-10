/**
 * Corpus cases too large to keep as files: each one is built here, from a
 * few numbers, instead of being stored as megabytes of repeated lanes.
 *
 * @remarks
 * The corpus readers treat every case below as if it were a file of the same
 * name in the same group, so each check that runs on the corpus files also
 * runs on these cases. `corpus-generated.test.ts` pins the sha256 of
 * `JSON.stringify` of each case, so a change to a builder is a deliberate
 * change to the corpus.
 */

/** The corpus folder a case belongs to. */
export type CorpusGroup = "valid" | "invalid";

/** One generated corpus case, under the file name it stands for. */
export interface GeneratedCorpusCase {
  readonly group: CorpusGroup;
  readonly name: string;
  readonly value: {
    readonly description: string;
    readonly rules: null;
    readonly spec: unknown;
    readonly expectCodes: readonly string[];
  };
}

/** How one lane of a generated spec differs from a plain worker lane. */
interface LaneOptions {
  readonly role?: string;
  readonly dependsOn?: (index: number) => string[];
  readonly allowedPaths?: (index: number) => string[];
}

/** By default a lane waits for the lane ten places before it. */
function waveDependency(index: number): string[] {
  return index >= 10 ? [`lane-${index - 10}`] : [];
}

/** A spec of `count` lanes that share every field but their id and paths. */
function lanesSpec(count: number, options: LaneOptions = {}): unknown {
  const lanes: unknown[] = [];
  for (let index = 0; index < count; index++) {
    lanes.push({
      taskId: `lane-${index}`,
      title: `Lane ${index}`,
      role: options.role ?? "worker",
      dependsOn: (options.dependsOn ?? waveDependency)(index),
      allowedPaths: options.allowedPaths?.(index) ?? [`src/lane-${index}`],
      agent: {
        providerId: "codex",
        model: "gpt-5.5",
        mode: "workspace-write",
        tools: [],
      },
      steps: { testsFirst: false, review: { kind: "none" } },
    });
  }
  return {
    specVersion: 1,
    workflowId: "lanes",
    workflowVersion: "1",
    projectRoot: ".",
    budget: { maxUsd: 5 },
    maxConcurrency: 2,
    lanes,
    gates: {
      qa: [{ id: "test", command: ["bun", "run", "test"] }],
      publish: { kind: "commit", hitl: true },
    },
    env: ["CI"],
  };
}

/** The ids of the lanes before `index`, nearest first, at most `limit`. */
function previousLanes(index: number, limit: number): string[] {
  const ids: string[] = [];
  for (let other = index - 1; other >= 0 && other >= index - limit; other--) {
    ids.push(`lane-${other}`);
  }
  return ids;
}

/** `count` paths under the lane's own folder. */
function lanePaths(index: number, count: number): string[] {
  return Array.from(
    { length: count },
    (_, path) => `src/lane-${index}/p${path}`,
  );
}

/** Builds every generated corpus case, in name order within each group. */
export function generatedCorpusCases(): GeneratedCorpusCase[] {
  return [
    {
      group: "invalid",
      name: "run_spec_issues_truncated.json",
      value: {
        description:
          "260 lanes each have an invalid role; the list is cut at 256 issues.",
        rules: null,
        spec: lanesSpec(260, { role: "lead" }),
        expectCodes: ["RUN_SPEC_ISSUES_TRUNCATED", "RUN_SPEC_INVALID_VALUE"],
      },
    },
    {
      group: "invalid",
      name: "run_spec_plan_rejected.json",
      value: {
        description:
          "An acyclic graph of 300 lanes where each lane depends on the 64 lanes before it. Every graph rule accepts it, but even without paths the projected plan has more than the 20,000 values the orchestration JSON store allows, so the budget family reports the plan size and the existing plan validator rejects the lane graph.",
        rules: null,
        spec: lanesSpec(300, {
          dependsOn: (index) => previousLanes(index, 64),
        }),
        expectCodes: ["RUN_SPEC_PLAN_TOO_LARGE", "RUN_SPEC_PLAN_REJECTED"],
      },
    },
    {
      group: "invalid",
      name: "run_spec_plan_too_large.json",
      value: {
        description:
          "1,000 lanes with 64 paths each: the workflow plan is beyond the plan store limits.",
        rules: null,
        spec: lanesSpec(1000, {
          allowedPaths: (index) => lanePaths(index, 64),
        }),
        expectCodes: ["RUN_SPEC_PLAN_TOO_LARGE"],
      },
    },
    {
      group: "invalid",
      name: "run_spec_too_many_lanes.json",
      value: {
        description: "The spec has 1,001 lanes, over the hard limit of 1,000.",
        rules: null,
        spec: lanesSpec(1001),
        expectCodes: ["RUN_SPEC_TOO_MANY_LANES"],
      },
    },
    {
      group: "valid",
      name: "wide-120-lanes.json",
      value: {
        description:
          "A run of 120 lanes in waves of ten, each on its own path.",
        rules: null,
        spec: lanesSpec(120),
        expectCodes: [],
      },
    },
  ];
}
