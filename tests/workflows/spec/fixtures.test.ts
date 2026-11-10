import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRunPlan } from "../../../src/workflows/spec/plan.js";
import {
  type RunRules,
  RunRulesSchema,
} from "../../../src/workflows/spec/schema.js";
import type { RunPlan } from "../../../src/workflows/spec/types.js";
import { validateRunSpec } from "../../../src/workflows/spec/validate.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Keys every fixture file has, and no others. */
const FIXTURE_KEYS = ["description", "rules", "spec"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks that every wave of the plan lists each lane once, that the lane's
 * `waveIndex` matches its wave, and that every dependency sits in an
 * earlier wave.
 */
function expectWavesRespectDependencies(plan: RunPlan): void {
  const waveOf = new Map<string, number>();
  plan.waves.forEach((wave, index) => {
    for (const taskId of wave.taskIds) {
      expect(waveOf.has(taskId)).toBe(false);
      waveOf.set(taskId, index);
    }
  });
  expect([...waveOf.keys()].sort()).toEqual(
    plan.lanes.map((lane) => lane.taskId).sort(),
  );
  for (const lane of plan.lanes) {
    const laneWave = waveOf.get(lane.taskId) ?? Number.NaN;
    expect(lane.waveIndex).toBe(laneWave);
    for (const dependency of lane.dependsOn) {
      const dependencyWave = waveOf.get(dependency) ?? Number.NaN;
      expect(dependencyWave).toBeLessThan(laneWave);
    }
  }
}

const fixtureFiles = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort();

/** Fixtures the lane must provide, by file name. */
const REQUIRED_FIXTURES = ["fix-df.json", "monorepo-2.json"];

describe("run spec fixtures", () => {
  test("the fixture directory holds at least one fixture", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  test("the required fixtures are present", () => {
    for (const file of REQUIRED_FIXTURES) {
      expect(fixtureFiles).toContain(file);
    }
  });

  for (const file of fixtureFiles) {
    describe(file, () => {
      const document: unknown = JSON.parse(
        readFileSync(join(FIXTURE_DIR, file), "utf8"),
      );

      test("is an object with exactly a description, rules and a spec", () => {
        expect(isRecord(document)).toBe(true);
        if (!isRecord(document)) return;
        expect(Object.keys(document).sort()).toEqual(FIXTURE_KEYS);
      });

      test("declares a non-empty description", () => {
        if (!isRecord(document)) throw new Error("fixture is not an object");
        expect(typeof document.description).toBe("string");
        expect(String(document.description).trim().length).toBeGreaterThan(0);
      });

      test("declares a rule set that parses", () => {
        if (!isRecord(document)) throw new Error("fixture is not an object");
        expect(RunRulesSchema.safeParse(document.rules).success).toBe(true);
      });

      test("its spec validates under its rules", () => {
        if (!isRecord(document)) throw new Error("fixture is not an object");
        const result = validateRunSpec(
          document.spec,
          document.rules as RunRules,
        );
        expect(result.ok ? [] : result.errors).toEqual([]);
      });

      test("resolves to a plan whose waves respect dependsOn", () => {
        if (!isRecord(document)) throw new Error("fixture is not an object");
        const result = resolveRunPlan(
          document.spec,
          document.rules as RunRules,
        );
        expect(result.ok ? [] : result.errors).toEqual([]);
        if (!result.ok) return;
        const specLanes = (document.spec as { lanes: unknown[] }).lanes;
        expect(result.plan.lanes.length).toBe(specLanes.length);
        expectWavesRespectDependencies(result.plan);
      });
    });
  }
});

/**
 * Files and folders each finding of the recorded fix run owned, by lane id,
 * as listed in that run's script.
 */
const FIX_RUN_OWNED_PATHS: Readonly<Record<string, readonly string[]>> = {
  "resume-marker": [
    "src/workflows/index.ts",
    "src/workflows/events.ts",
    "src/workflows/contracts.ts",
    "src/workflows/runtime",
    "src/workflows/checkpoint",
    "src/workflows/workflow-agent.ts",
    "src/workflows/script-workflow-agent.ts",
    "tests/workflows",
    "docs/workflow-durability.md",
    "docs/workflow-adk-interop.md",
    "CHANGELOG.md",
  ],
  "abort-state": [
    "src/workflows/index.ts",
    "src/workflows/events.ts",
    "src/workflows/contracts.ts",
    "src/workflows/runtime",
    "src/workflows/checkpoint",
    "src/workflows/workflow-agent.ts",
    "src/workflows/script-workflow-agent.ts",
    "src/workflows/node-config.ts",
    "tests/workflows",
    "tests/df-fixes",
    "docs/workflow-durability.md",
    "docs/workflow-adk-interop.md",
    "docs/migration-0.7.md",
    "docs/glossary.md",
    "CHANGELOG.md",
  ],
  "sub-workflow-usage": [
    "src/workflows/index.ts",
    "src/workflows/events.ts",
    "src/workflows/contracts.ts",
    "src/workflows/runtime",
    "src/workflows/workflow-agent.ts",
    "src/workflows/script-workflow-agent.ts",
    "src/runtime/agent-invocation-gateway.ts",
    "tests/workflows",
    "tests/runtime",
    "docs/workflow-adk-interop.md",
    "docs/workflow-orchestration.md",
    "docs/workflow-durability.md",
    "CHANGELOG.md",
  ],
  "resumed-session-cost": [
    "src/agents/driver/claude-agent-sdk.ts",
    "src/agents/driver/run-summary.ts",
    "src/agents/driver/claude-cli.ts",
    "src/agents/events.ts",
    "src/agents/telemetry.ts",
    "tests/agents",
    "docs/external-agent-isolation.md",
    "README.md",
    "CHANGELOG.md",
  ],
  "tool-isolation": [
    "src/agents/driver/claude-isolation.ts",
    "src/agents/driver/claude-agent-sdk.ts",
    "src/agents/driver/claude-cli.ts",
    "tests/agents",
    "docs/external-agent-isolation.md",
    "CHANGELOG.md",
  ],
};

/** Whether `path` is `owner` or lies inside the folder `owner`. */
function isWithin(path: string, owner: string): boolean {
  return path === owner || path.startsWith(`${owner}/`);
}

describe("the fix run fixture", () => {
  const document = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "fix-df.json"), "utf8"),
  ) as { spec: { lanes: { taskId: string; allowedPaths: string[] }[] } };
  const lanes = document.spec.lanes;

  test("has one lane per finding of the recorded run", () => {
    expect(lanes.map((lane) => lane.taskId).sort()).toEqual(
      Object.keys(FIX_RUN_OWNED_PATHS).sort(),
    );
  });

  test("gives each lane only paths its finding owned", () => {
    const outside: string[] = [];
    for (const lane of lanes) {
      const owned = FIX_RUN_OWNED_PATHS[lane.taskId] ?? [];
      for (const path of lane.allowedPaths) {
        if (!owned.some((owner) => isWithin(path, owner))) {
          outside.push(`${lane.taskId}: ${path}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });

  test("gives no two lanes the same or nested paths", () => {
    const shared: string[] = [];
    for (const [index, lane] of lanes.entries()) {
      for (const other of lanes.slice(index + 1)) {
        for (const path of lane.allowedPaths) {
          for (const otherPath of other.allowedPaths) {
            if (isWithin(path, otherPath) || isWithin(otherPath, path)) {
              shared.push(`${lane.taskId} and ${other.taskId}: ${path}`);
            }
          }
        }
      }
    }
    expect(shared).toEqual([]);
  });
});

describe("the monorepo fixture", () => {
  const document = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "monorepo-2.json"), "utf8"),
  ) as {
    rules: RunRules;
    spec: { gates: { publish: { kind: string; hitl?: boolean } } };
  };

  test("runs design and scaffold together, then contracts, 13 lanes and integration", () => {
    const result = resolveRunPlan(document.spec, document.rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const waves = result.plan.waves.map((wave) => [...wave.taskIds].sort());
    expect(waves.length).toBe(4);
    expect(waves[0]).toEqual(["design", "scaffold"]);
    expect(waves[1]).toEqual(["contracts"]);
    expect(waves[2]).toHaveLength(13);
    expect(waves[2]).toContain("web-flow");
    expect(waves[2]).toContain("srv-steps");
    expect(waves[3]).toEqual(["integration"]);
  });

  test("ends with an integration that waits for a human", () => {
    expect(document.spec.gates.publish.kind).toBe("integration");
    expect(document.spec.gates.publish.hitl).toBe(true);
  });
});
