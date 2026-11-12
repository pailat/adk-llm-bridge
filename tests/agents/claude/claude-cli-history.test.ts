/**
 * The Claude CLI driver has no native resume, so a new `claude -p` process
 * must see the earlier turns of the ADK session in its prompt. The `claude`
 * here is a fake shell script that records the stdin of every run and
 * answers with a fixed reply; the real binary is never run.
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
import { createEvent, InMemoryRunner } from "@google/adk";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { ExternalAgent } from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `claude` that saves the stdin of run N to `stdin-N` and replies
 * `reply N`.
 */
function fakeClaude(): { command: string; stdin(run: number): string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-claude-")));
  dirs.push(dir);
  const command = join(dir, "claude");
  const counter = join(dir, "count");
  writeFileSync(counter, "0");
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `n=$(( $(cat '${counter}') + 1 ))`,
      `printf '%s' "$n" > '${counter}'`,
      `cat > '${dir}/stdin-'"$n"`,
      `printf '{"type":"result","subtype":"success","is_error":false,"result":"reply %s"}\\n' "$n"`,
      "",
    ].join("\n"),
  );
  chmodSync(command, 0o755);
  return {
    command,
    stdin: (run) => readFileSync(join(dir, `stdin-${run}`), "utf8"),
  };
}

describe.skipIf(process.platform === "win32")(
  "Claude CLI prompt carries the ADK history",
  () => {
    test("turn 2 sees turn 1's question and reply; thoughts are left out", async () => {
      const fake = fakeClaude();
      const agent = new ExternalAgent({
        name: "worker",
        provider: CLAUDE_PROVIDER,
        instruction: "Be brief.",
        driver: new ClaudeCliDriver({
          command: fake.command,
          env: { PATH: "/usr/bin:/bin" },
        }),
      });
      const runner = new InMemoryRunner({ agent, appName: "app" });
      const session = await runner.sessionService.createSession({
        appName: "app",
        userId: "user",
      });
      const send = async (text: string) => {
        for await (const _ of runner.runAsync({
          userId: "user",
          sessionId: session.id,
          newMessage: { role: "user", parts: [{ text }] },
        })) {
          // drain
        }
      };

      await send("remember the phrase blue-heron");
      // A thought the model produced in turn 1: never replayed.
      const stored = await runner.sessionService.getSession({
        appName: "app",
        userId: "user",
        sessionId: session.id,
      });
      if (!stored) throw new Error("session missing");
      await runner.sessionService.appendEvent({
        session: stored,
        event: createEvent({
          invocationId: "turn-1",
          author: "worker",
          content: {
            role: "model",
            parts: [{ text: "secret reasoning", thought: true }],
          },
        }),
      });
      await send("which phrase did I give you?");

      const first = fake.stdin(1);
      expect(first).toContain("remember the phrase blue-heron");
      expect(first).not.toContain("assistant:");
      expect(first).not.toContain("user:");

      const second = fake.stdin(2);
      expect(second.startsWith("Be brief.")).toBe(true);
      expect(second).toContain("user:\nremember the phrase blue-heron");
      expect(second).toContain("assistant:\nreply 1");
      expect(second).not.toContain("secret reasoning");
      // The current turn comes last, once.
      expect(second.endsWith("which phrase did I give you?")).toBe(true);
      expect(second.split("which phrase did I give you?")).toHaveLength(2);
    });
  },
);
