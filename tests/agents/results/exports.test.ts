import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import * as agents from "../../../src/agents/index.js";
import * as results from "../../../src/agents/results/index.js";
import * as spec from "../../../src/workflows/spec/index.js";

const barrel = join(import.meta.dir, "../../../src/agents/results/index.ts");

/** Value names the barrel re-exports (type-only lists are skipped). */
function declaredValueExports(): string[] {
  const source = readFileSync(barrel, "utf8");
  return [...source.matchAll(/export\s*(type\s*)?\{([^}]*)\}\s*from/gu)]
    .filter((match) => match[1] === undefined)
    .flatMap((match) =>
      (match[2] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );
}

describe("agents/results subpath", () => {
  test("package exports publishes the subpath", () => {
    expect(packageJson.exports["./agents/results"]).toEqual({
      types: "./dist/agents/results/index.d.ts",
      import: "./dist/agents/results/index.js",
    });
  });

  test("exposes exactly the value exports of its barrel", () => {
    const declared = declaredValueExports();
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(results).sort()).toEqual([...declared].sort());
  });

  test("the barrel has no star exports", () => {
    expect(readFileSync(barrel, "utf8")).not.toMatch(/export\s*\*/u);
  });

  test("its values are not on the agents entry or the run spec entry", () => {
    // The schemas are not wired into the run spec, so its hash is unchanged.
    for (const name of Object.keys(results)) {
      expect({ name, inAgents: name in agents }).toEqual({
        name,
        inAgents: false,
      });
      expect({ name, inSpec: name in spec }).toEqual({ name, inSpec: false });
    }
  });
});
