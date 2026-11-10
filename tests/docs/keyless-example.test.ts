/**
 * Runs examples/keyless/index.ts (with `adk-llm-bridge` resolved to this
 * checkout's source) so the sample that needs no API key keeps working.
 * Network use is limited to the example's own server on 127.0.0.1.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXAMPLE = new URL("../../examples/keyless/index.ts", import.meta.url);
const SOURCE_ENTRY = fileURLToPath(
  new URL("../../src/index.ts", import.meta.url),
);

describe("examples/keyless", () => {
  it("runs an agent end to end without an API key", async () => {
    const source = readFileSync(EXAMPLE, "utf8");
    expect(source).toContain('from "adk-llm-bridge"');
    // Written next to this test so `@google/adk` resolves from the root
    // node_modules; removed afterwards.
    const copy = new URL(
      `./.keyless-example-${process.pid}.tmp.ts`,
      import.meta.url,
    );
    writeFileSync(
      copy,
      source.replace(
        'from "adk-llm-bridge"',
        `from ${JSON.stringify(SOURCE_ENTRY)}`,
      ),
    );
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        // No provider key or endpoint may leak into the run.
        if (value !== undefined && !/API_KEY|BASE_URL/.test(key)) {
          env[key] = value;
        }
      }
      const child = Bun.spawn([process.execPath, fileURLToPath(copy)], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      expect(stdout.trim()).toBe("assistant: Hello from a local model.");
    } finally {
      rmSync(copy, { force: true });
    }
  }, 30_000);
});
