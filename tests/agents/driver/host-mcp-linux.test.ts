/**
 * Declared MCP server checks against a real Linux kernel and file system:
 * `ptrace_scope` from `/proc`, the `/proc` read term with real paths and
 * symlinks, and the stdio root checks for the host's temp directories.
 * Skipped on other platforms; the Linux gate runs them.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  checkClaudeMcpServers,
  checkStdioServerForRun,
} from "../../../src/agents/driver/claude-mcp-servers.js";
import {
  checkMcpSecretsEnforceable,
  envReadableReason,
  type McpSecretRunContext,
  readPtraceScope,
} from "../../../src/agents/driver/mcp-secrets.js";
import {
  EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
  EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import { sandboxTempRoots } from "../../../src/agents/driver/shared.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const LINUX = process.platform === "linux";
const PTRACE_FILE = "/proc/sys/kernel/yama/ptrace_scope";

// Host-side scratch outside every temp directory, so only the roots under
// test decide.
const hostRoot = join(homedir(), `.host-mcp-linux-${process.pid}`);
const tempRoot = LINUX ? mkdtempSync(join(tmpdir(), "host-mcp-linux-")) : "";
afterAll(() => {
  rmSync(hostRoot, { recursive: true, force: true });
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

function run(extra: Partial<McpSecretRunContext>): McpSecretRunContext {
  return {
    platform: "linux",
    shellOffered: false,
    shellSandboxed: true,
    fileReadOffered: false,
    policy: undefined,
    workingDirectory: hostRoot,
    readPtraceScope,
    childEnv: {},
    ...extra,
  };
}

function executable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    return (error as ExternalAgentPolicyError).code;
  }
  return undefined;
}

describe.skipIf(!LINUX)("Linux: ptrace_scope from the real /proc", () => {
  const resolveHeader = checkClaudeMcpServers({
    docs: {
      type: "http",
      url: "http://127.0.0.1:1/",
      headers: { Authorization: { resolve: () => "secret-value" } },
    },
  });

  test("readPtraceScope reads the kernel file, or gives undefined without Yama", () => {
    const expected = existsSync(PTRACE_FILE)
      ? readFileSync(PTRACE_FILE, "utf8").trim()
      : undefined;
    expect(readPtraceScope()).toBe(expected);
    console.log(`ptrace_scope on this host: ${expected ?? "missing"}`);
  });

  test("a shell with a declared secret: refused for 0 or missing, accepted for 1 or more", () => {
    const scope = readPtraceScope();
    const code = codeOf(() =>
      checkMcpSecretsEnforceable(resolveHeader, run({ shellOffered: true })),
    );
    if (scope === undefined || scope === "0") {
      expect(code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    } else {
      expect(code).toBeUndefined();
    }
  });

  test("without a shell the ptrace term does not apply", () => {
    expect(
      codeOf(() => checkMcpSecretsEnforceable(resolveHeader, run({}))),
    ).toBeUndefined();
  });
});

describe.skipIf(!LINUX)("Linux: the /proc read term with real paths", () => {
  const work = join(hostRoot, "work");
  mkdirSync(work, { recursive: true });
  const reads = (readPaths: string[]) =>
    envReadableReason(
      run({
        fileReadOffered: true,
        workingDirectory: work,
        policy: { mode: "workspace-write", allowedPaths: [work], readPaths },
      }),
    );

  test("reads confined to the work dir do not reach /proc", () => {
    expect(reads([])).toBeUndefined();
    expect(reads([work])).toBeUndefined();
  });

  test("a read root of /, /proc or /proc/self reaches /proc", () => {
    for (const root of ["/", "/proc", "/proc/self"]) {
      expect(reads([root])).toContain("/proc");
    }
  });

  test("a symlink into /proc counts as /proc", () => {
    const link = join(hostRoot, "proc-link");
    symlinkSync("/proc/self", link);
    expect(reads([link])).toContain("/proc");
    const rootLink = join(hostRoot, "root-link");
    symlinkSync("/", rootLink);
    expect(reads([rootLink])).toContain("/proc");
  });
});

describe.skipIf(!LINUX)(
  "Linux: stdio root checks on the real file system",
  () => {
    const roots = sandboxTempRoots(process.env);
    const server = (command: string) =>
      new ClaudeAgentSdkDriver({
        sdk: {
          query: () => {
            throw new Error("query must not run");
          },
        } as never,
        env: { PATH: process.env.PATH },
        tools: ["Read"],
        mcpServers: { proc: { type: "stdio", command } },
      });
    const request = (): ExternalAgentRunRequest =>
      ({
        provider: CLAUDE_PROVIDER,
        context: { input: "x" } as never,
        workingDirectory: join(hostRoot, "work"),
        permissions: { mode: "workspace-write" },
      }) as ExternalAgentRunRequest;
    async function errorCode(command: string): Promise<string | undefined> {
      const events: ExternalAgentEvent[] = [];
      for await (const event of server(command).run(request())) {
        events.push(event);
      }
      const error = events.find((event) => event.type === "error") as
        | { code?: string }
        | undefined;
      return error?.code;
    }

    test("/tmp and the process temp dir are sandbox temp roots", () => {
      expect(roots).toContain("/tmp");
      expect(
        codeOf(() =>
          checkStdioServerForRun(
            { name: "s", command: executable(tempRoot, "srv") },
            roots,
          ),
        ),
      ).toBe(EXTERNAL_AGENT_MCP_STDIO_UNSAFE);
    });

    test.skipIf(!existsSync("/var/tmp"))(
      "a command in /var/tmp is refused at run time",
      async () => {
        const dir = mkdtempSync("/var/tmp/host-mcp-linux-");
        try {
          expect(await errorCode(executable(dir, "srv"))).toBe(
            EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test.skipIf(!existsSync("/dev/shm"))(
      "a command in /dev/shm is refused at run time",
      async () => {
        let dir: string;
        try {
          dir = mkdtempSync("/dev/shm/host-mcp-linux-");
        } catch {
          return; // not writable in this container
        }
        try {
          expect(await errorCode(executable(dir, "srv"))).toBe(
            EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test("a host command through a symlink into the work dir is refused", async () => {
      const target = executable(join(hostRoot, "work"), "inside");
      const link = join(hostRoot, "bin", "outside");
      mkdirSync(join(hostRoot, "bin"), { recursive: true });
      symlinkSync(target, link);
      expect(await errorCode(link)).toBe(EXTERNAL_AGENT_MCP_STDIO_UNSAFE);
    });

    test("a host command outside every root passes the stdio checks", () => {
      const command = executable(join(hostRoot, "host-bin"), "srv");
      const config = join(hostRoot, "host-bin", "config.json");
      writeFileSync(config, "{}");
      expect(
        checkStdioServerForRun(
          { name: "s", command, args: ["-v", config, `--config=${config}`] },
          [join(hostRoot, "work"), ...roots],
        ),
      ).toEqual({ command, args: ["-v", config, `--config=${config}`] });
    });

    test("a file without the exec bit, and a directory, are refused", () => {
      const plain = join(hostRoot, "host-bin", "plain");
      mkdirSync(join(hostRoot, "host-bin"), { recursive: true });
      writeFileSync(plain, "");
      chmodSync(plain, 0o644);
      expect(
        codeOf(() =>
          checkStdioServerForRun({ name: "s", command: plain }, roots),
        ),
      ).toBe(EXTERNAL_AGENT_MCP_STDIO_UNSAFE);
      expect(
        codeOf(() =>
          checkStdioServerForRun({ name: "s", command: hostRoot }, roots),
        ),
      ).toBe(EXTERNAL_AGENT_MCP_STDIO_UNSAFE);
    });
  },
);
