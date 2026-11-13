/**
 * The Claude CLI driver gives the prompt to `claude -p` on stdin, never as a
 * positional argument: Commander dispatches a subcommand from the first
 * operand even after `--`, so a prompt such as `update` would run
 * `claude update`. The `claude` here is a fake shell script that records its
 * argv and stdin; the real binary is never run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A fake `claude` that writes its argv (one per line) and its stdin. */
function fakeClaude(): { command: string; argv(): string[]; stdin(): string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-claude-")));
  dirs.push(dir);
  const command = join(dir, "claude");
  const argvFile = join(dir, "argv");
  const stdinFile = join(dir, "stdin");
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `: > '${argvFile}'`,
      `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argvFile}'; done`,
      `cat > '${stdinFile}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`,
      "",
    ].join("\n"),
  );
  chmodSync(command, 0o755);
  return {
    command,
    argv: () => readFileSync(argvFile, "utf8").split("\n").slice(0, -1),
    stdin: () => readFileSync(stdinFile, "utf8"),
  };
}

async function run(driver: ClaudeCliDriver, input: string) {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run({
    provider: CLAUDE_PROVIDER,
    context: { input } as never,
    permissions: { mode: "ask", allowNetwork: true },
  })) {
    events.push(event);
  }
  return events;
}

describe.skipIf(process.platform === "win32")(
  "Claude CLI prompt on stdin",
  () => {
    test("a prompt that names a subcommand reaches claude only on stdin", async () => {
      const fake = fakeClaude();
      const driver = new ClaudeCliDriver({
        command: fake.command,
        args: ["--max-budget-usd", "2"],
        env: { PATH: "/usr/bin:/bin" },
      });

      const events = await run(driver, "update");

      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
      expect(fake.stdin()).toBe("update");
      const argv = fake.argv();
      expect(argv).not.toContain("update");
      expect(argv.slice(0, 4)).toEqual([
        "-p",
        "--input-format",
        "text",
        "--output-format",
      ]);
      // Every argument is a flag or a flag's value; no operand follows.
      expect(argv.at(-2)).toBe("--max-budget-usd");
      expect(argv.at(-1)).toBe("2");
    });

    test("a prompt that looks like a flag is stdin text, not an argument", async () => {
      const fake = fakeClaude();
      const driver = new ClaudeCliDriver({
        command: fake.command,
        env: { PATH: "/usr/bin:/bin" },
      });

      await run(driver, "--dangerously-skip-permissions");

      expect(fake.stdin()).toBe("--dangerously-skip-permissions");
      expect(fake.argv()).not.toContain("--dangerously-skip-permissions");
    });
  },
);
