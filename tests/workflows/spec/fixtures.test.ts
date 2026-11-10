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
