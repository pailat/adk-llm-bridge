/**
 * Guards two documentation claims that must match the code:
 * - a string `instruction` is an ADK state template (README and the
 *   most relevant guide say so);
 * - which locks keep `*.retired.*` directories.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BaseLlm,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";

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

  it("the installed ADK throws for a missing key and takes functions", async () => {
    const seen: string[] = [];

    class FakeLlm extends BaseLlm {
      constructor() {
        super({ model: "fake-model" });
      }
      async *generateContentAsync(
        request: LlmRequest,
      ): AsyncGenerator<LlmResponse, void> {
        seen.push(String(request.config?.systemInstruction ?? ""));
        yield { content: { role: "model", parts: [{ text: "ok" }] } };
      }
      async connect(): Promise<never> {
        throw new Error("not supported");
      }
    }

    async function run(instruction: string | (() => string)): Promise<void> {
      const agent = new LlmAgent({
        name: "probe",
        model: new FakeLlm(),
        instruction,
      });
      const runner = new InMemoryRunner({ agent, appName: "probe-app" });
      const events = runner.runEphemeral({
        userId: "user",
        newMessage: { role: "user", parts: [{ text: "hi" }] },
      });
      for await (const _event of events) {
        // drain
      }
    }

    await expect(run("x {missing}")).rejects.toThrow(
      /Context variable not found/,
    );
    await run(() => "x {missing}");
    expect(seen.some((text) => text.includes("x {missing}"))).toBe(true);
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
