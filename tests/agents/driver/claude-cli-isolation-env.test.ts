/**
 * The Claude CLI driver passes its configured `env` to the isolation plan, so
 * a `TMPDIR` or `CLAUDE_CODE_TMPDIR` the runtime gets counts as an
 * always-writable temp directory, as for the SDK driver.
 */

import { expect, test } from "bun:test";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/index.js";

const workingDirectory = "/opt/adk-bridge-cli-env-workspace";

for (const key of ["TMPDIR", "CLAUDE_CODE_TMPDIR"]) {
  test(`a configured ${key} around the workspace makes shell paths unenforceable`, () => {
    const plan = (env: Record<string, string | undefined>) =>
      new ClaudeCliDriver({ env, tools: ["Bash", "Read"] }).isolationPlan({
        provider: CLAUDE_PROVIDER,
        context: {} as never,
        workingDirectory,
        permissions: {
          mode: "workspace-write",
          allowedPaths: [workingDirectory],
        },
      });
    expect(plan({ [key]: "/opt" }).shellPathsUnenforceable).toContain(
      "temp directory",
    );
    expect(plan({ PATH: "/usr/bin" }).shellPathsUnenforceable).toBeUndefined();
  });
}
