/**
 * Guards two documentation claims that must match the code:
 * - a string `instruction` is an ADK state template (README and the
 *   most relevant guide say so);
 * - which locks keep `*.retired.*` directories.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("string instruction is an ADK state template", () => {
  for (const path of ["README.md", "docs/workflow-orchestration.md"]) {
    it(`${path} explains the template and the safe alternatives`, () => {
      const text = flat(read(path));
      expect(text).toContain("Context variable not found");
      expect(text).toMatch(/session state/i);
      expect(text).toContain("instruction: () =>");
    });
  }

  it("the installed ADK throws for a missing key and takes functions", () => {
    const base = "../../node_modules/@google/adk/dist/esm/agents";
    const instructions = readFileSync(
      new URL(`${base}/instructions.js`, import.meta.url),
      "utf8",
    );
    const agent = readFileSync(
      new URL(`${base}/llm_agent.js`, import.meta.url),
      "utf8",
    );
    expect(instructions).toContain("Context variable not found");
    expect(agent).toContain("requireStateInjection: true");
    expect(agent).toContain("await this.instruction(context2)");
  });
});

describe("migration guide on retired lock directories", () => {
  const migration = flat(read("docs/migration-0.7.md"));
  const orchestration = flat(read("docs/workflow-orchestration.md"));

  it("says a release removes its own tombstone and recovery keeps one", () => {
    expect(migration).toContain("Lock tombstones.");
    expect(migration).toMatch(/release[^.]*removes its own `\*\.retired\.\*`/i);
    expect(migration).toMatch(/recovered from dead processes/i);
    expect(migration).not.toMatch(/Released locks no longer leave/);
  });

  it("does not say every repository-lock release leaves a directory", () => {
    expect(orchestration).not.toContain(
      "Each release, and each recovery of a dead owner's lock, leaves",
    );
    expect(orchestration).toContain(".repository-<hash>.lock.retired.<hash>");
  });
});
