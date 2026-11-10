import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { planClaudeIsolation } from "../../../src/agents/driver/claude-isolation.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import {
  guardPermissionRequest,
  type PermissionDecision,
  type PermissionRequest,
} from "../../../src/agents/permissions/confirmation.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/claude.js";

type HookFn = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID?: string; blockedPath?: string },
) => Promise<{ behavior: string }>;

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A fake Claude Agent SDK that applies the bridge's options the way Claude
 * Code does and performs reads and writes for real: `PreToolUse` hooks run
 * first; reads inside `cwd` and `additionalDirectories` run without asking,
 * and so do edits there under `acceptEdits`; every other call goes to
 * `canUseTool` (denied without one); Bash writes only inside `cwd` and
 * `sandbox.filesystem.allowWrite`.
 */
function fakeSdk(calls: readonly ToolCall[]) {
  const state = {
    outcomes: [] as string[],
    asked: [] as string[],
    options: undefined as Record<string, unknown> | undefined,
  };
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      const options = input.options;
      state.options = options;
      const cwd = options.cwd as string;
      const mode = options.permissionMode as string;
      const extra = (options.additionalDirectories as string[]) ?? [];
      const hooks =
        (options.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> })
          ?.PreToolUse ?? [];
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      const sandbox = options.sandbox as
        | { enabled?: boolean; filesystem?: { allowWrite?: string[] } }
        | undefined;
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-haiku-5-5",
          session_id: "s-1",
          tools: (options.tools as string[]) ?? [],
          mcp_servers: [],
        };
        for (const call of calls) {
          state.outcomes.push(await perform(call));
        }
        yield { type: "result", subtype: "success", result: "done" };
      })();

      async function perform(call: ToolCall): Promise<string> {
        for (const matcher of hooks) {
          for (const hook of matcher.hooks) {
            const output = (await hook(
              {
                hook_event_name: "PreToolUse",
                tool_name: call.tool,
                tool_input: call.input,
              },
              "tu",
              { signal: new AbortController().signal },
            )) as { hookSpecificOutput?: { permissionDecision?: string } };
            if (output.hookSpecificOutput?.permissionDecision === "deny") {
              return `${call.tool}:hook-denied`;
            }
          }
        }
        const path = String(
          call.input.file_path ??
            call.input.path ??
            /> (\S+)/u.exec(String(call.input.command))?.[1],
        );
        const inRoots = [cwd, ...extra].some((root) => under(path, root));
        const autoApproved =
          mode === "bypassPermissions" ||
          (READ_TOOLS.has(call.tool) && inRoots) ||
          (mode === "acceptEdits" && EDIT_TOOLS.has(call.tool) && inRoots);
        if (!autoApproved) {
          state.asked.push(call.tool);
          const decision = canUseTool
            ? await canUseTool(call.tool, call.input, {
                toolUseID: "tu",
                blockedPath: path,
              })
            : { behavior: "deny" };
          if (decision.behavior !== "allow") return `${call.tool}:denied`;
        }
        if (call.tool === "Read") {
          return `Read:${readFileSync(path, "utf8")}`;
        }
        if (READ_TOOLS.has(call.tool)) {
          return `${call.tool}:searched`;
        }
        if (call.tool === "Bash" && sandbox?.enabled) {
          const writable = [cwd, ...(sandbox.filesystem?.allowWrite ?? [])];
          if (!writable.some((root) => under(path, root))) {
            return "Bash:sandbox-denied";
          }
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "x");
        return `${call.tool}:written`;
      }
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, state };
}

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

// Outside every temp directory: the sandbox keeps the temp area writable,
// so a root there is refused while a shell is on offer.
const CACHE = join(import.meta.dir, "..", "..", "..", "node_modules", ".cache");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function layout(): { a: string; b: string; c: string } {
  mkdirSync(CACHE, { recursive: true });
  const root = realpathSync(mkdtempSync(join(CACHE, "read-paths-")));
  dirs.push(root);
  const a = join(root, "a");
  const b = join(root, "b");
  const c = join(root, "c");
  for (const dir of [a, b, c]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(b, "source.txt"), "from-b");
  writeFileSync(join(c, "secret.txt"), "from-c");
  return { a, b, c };
}

async function run(
  calls: ToolCall[],
  permissions: ExternalAgentPermissionPolicy,
  workingDirectory: string,
  host:
    | ((request: PermissionRequest) => Promise<PermissionDecision>)
    | undefined,
  tools: string[] = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
) {
  const { sdk, state } = fakeSdk(calls);
  const request: ExternalAgentRunRequest = {
    provider: CLAUDE_PROVIDER,
    context: { input: "probe" } as never,
    instruction: "probe",
    workingDirectory,
    permissions,
    ...(host ? { requestPermission: host } : {}),
  };
  const events = await collect(
    new ClaudeAgentSdkDriver({ sdk: sdk as never, tools }).run(request),
  );
  return { events, state };
}

const allowAll = async (): Promise<PermissionDecision> => ({
  behavior: "allow",
});

describe.skipIf(process.platform === "win32")(
  "Claude Agent SDK: a writer confined to A reads B and cannot write there",
  () => {
    for (const mode of ["workspace-write", "ask", "read-only"] as const) {
      for (const [label, host] of [
        ["a host that approves everything", allowAll],
        ["no host", undefined],
      ] as const) {
        test(`${mode}, ${label}`, async () => {
          const { a, b, c } = layout();
          const asked: string[] = [];
          const { events, state } = await run(
            [
              { tool: "Read", input: { file_path: join(b, "source.txt") } },
              { tool: "Grep", input: { pattern: "x", path: b } },
              { tool: "Read", input: { file_path: join(c, "secret.txt") } },
              // Read-only offers no write tool at all (isolation would stop
              // the run), so only the writable modes try them.
              ...(mode === "read-only"
                ? []
                : [
                    { tool: "Write", input: { file_path: join(b, "w.txt") } },
                    {
                      tool: "Edit",
                      input: { file_path: join(b, "source.txt") },
                    },
                    {
                      tool: "Bash",
                      input: { command: `echo x > ${b}/bash.txt` },
                    },
                  ]),
            ],
            { mode, allowedPaths: [a], readPaths: [b] },
            a,
            host
              ? async (request) => {
                  asked.push(request.toolName);
                  return host();
                }
              : undefined,
            mode === "read-only"
              ? ["Read", "Glob", "Grep"]
              : ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
          );
          expect(
            events.find((event) => event.type === "error"),
          ).toBeUndefined();
          expect(state.outcomes.slice(0, 3)).toEqual([
            "Read:from-b",
            "Grep:searched",
            "Read:hook-denied",
          ]);
          // The reads in B were approved by the driver, never by the host.
          expect(asked).not.toContain("Read");
          expect(asked).not.toContain("Grep");
          if (mode !== "read-only") {
            expect(state.outcomes.slice(3)).toEqual([
              "Write:hook-denied",
              "Edit:hook-denied",
              // With no host the prompt for Bash is denied before the
              // sandbox is reached; with one, the sandbox denies the write.
              host ? "Bash:sandbox-denied" : "Bash:denied",
            ]);
          }
          expect(existsSync(join(b, "w.txt"))).toBe(false);
          expect(existsSync(join(b, "bash.txt"))).toBe(false);
          expect(readFileSync(join(b, "source.txt"), "utf8")).toBe("from-b");
        });
      }
    }

    test("readPaths are never passed as additionalDirectories nor made writable", async () => {
      const { a, b } = layout();
      const { state } = await run(
        [],
        { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
        a,
        allowAll,
      );
      expect(state.options?.additionalDirectories).toEqual([a]);
      const sandbox = state.options?.sandbox as {
        filesystem?: { allowWrite?: string[] };
      };
      expect(sandbox.filesystem?.allowWrite).toEqual([a]);
    });

    test("without readPaths the driver approves nothing itself", async () => {
      const { a, b } = layout();
      const asked: string[] = [];
      const { state } = await run(
        [{ tool: "Read", input: { file_path: join(b, "source.txt") } }],
        { mode: "workspace-write", allowedPaths: [a, b] },
        a,
        async (request) => {
          asked.push(request.toolName);
          return { behavior: "deny", message: "no" };
        },
      );
      // B is an allowed root here, so Claude Code reads it unasked.
      expect(state.outcomes).toEqual(["Read:from-b"]);
      expect(asked).toEqual([]);
      const { state: other } = await run(
        [{ tool: "Read", input: { file_path: join(b, "source.txt") } }],
        { mode: "workspace-write", allowedPaths: [a] },
        a,
        undefined,
      );
      expect(other.outcomes).toEqual(["Read:hook-denied"]);
      expect(other.options?.canUseTool).toBeUndefined();
    });

    for (const withHost of [true, false]) {
      test(`a read whose blockedPath leaves the read roots is not approved by the driver (${withHost ? "host" : "no host"})`, async () => {
        const { a, b, c } = layout();
        const policy: ExternalAgentPermissionPolicy = {
          mode: "workspace-write",
          allowedPaths: [a],
          readPaths: [b],
        };
        const asked: PermissionRequest[] = [];
        const { state } = await run(
          [],
          policy,
          a,
          withHost
            ? async (request) => {
                asked.push(request);
                // The host applies the guard, as ExternalAgent does.
                return (
                  guardPermissionRequest(policy, request, {
                    workingDirectory: a,
                  }) ?? { behavior: "allow" }
                );
              }
            : undefined,
        );
        const canUseTool = state.options?.canUseTool as CanUseTool;
        const decision = await canUseTool(
          "Read",
          { file_path: join(b, "source.txt") },
          { toolUseID: "tu", blockedPath: join(c, "secret.txt") },
        );
        expect(decision.behavior).toBe("deny");
        if (withHost) {
          // Not approved as a read in readPaths: the host saw the call and
          // its guard denied the blocked path.
          expect(asked.map((request) => request.blockedPath)).toEqual([
            join(c, "secret.txt"),
          ]);
        }
        // The same read without the outside blockedPath is approved unasked.
        const plain = await canUseTool(
          "Read",
          { file_path: join(b, "source.txt") },
          { toolUseID: "tu" },
        );
        expect(plain.behavior).toBe("allow");
        expect(asked.length).toBe(withHost ? 1 : 0);
      });
    }

    test("in ask mode a write inside allowedPaths still goes to the host", async () => {
      const { a, b } = layout();
      const asked: string[] = [];
      const { state } = await run(
        [{ tool: "Write", input: { file_path: join(a, "w.txt") } }],
        { mode: "ask", allowedPaths: [a], readPaths: [b] },
        a,
        async (request) => {
          asked.push(request.toolName);
          return { behavior: "deny", message: "no" };
        },
      );
      expect(asked).toEqual(["Write"]);
      expect(state.outcomes).toEqual(["Write:denied"]);
      expect(existsSync(join(a, "w.txt"))).toBe(false);
    });

    test("a write inside readPaths is denied before the host is asked", async () => {
      const { a, b } = layout();
      const asked: string[] = [];
      const { state } = await run(
        [{ tool: "Write", input: { file_path: join(b, "w.txt") } }],
        { mode: "ask", allowedPaths: [a], readPaths: [b] },
        a,
        async (request) => {
          asked.push(request.toolName);
          return { behavior: "allow" };
        },
      );
      expect(state.outcomes).toEqual(["Write:hook-denied"]);
      expect(asked).toEqual([]);
      expect(existsSync(join(b, "w.txt"))).toBe(false);
    });
  },
);

describe("the Claude sandbox keeps readPaths out of its writable roots", () => {
  test("allowWrite is allowedPaths only", () => {
    const { a, b } = layout();
    const plan = planClaudeIsolation(
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
      {
        inheritHostConfig: false,
        allowUnsandboxedShell: false,
        workingDirectory: a,
        env: {},
      },
    );
    expect(plan.shellPathsUnenforceable).toBeUndefined();
    expect(
      (plan.sandbox as { filesystem?: { allowWrite?: string[] } }).filesystem
        ?.allowWrite,
    ).toEqual([a]);
  });

  test("read rules without write roots leave the shell no writable root", () => {
    const { a, b } = layout();
    const plan = planClaudeIsolation(
      { mode: "workspace-write", readPathBounds: [[a, b]] },
      {
        inheritHostConfig: false,
        allowUnsandboxedShell: false,
        workingDirectory: a,
        env: {},
      },
    );
    expect(plan.shellPathsUnenforceable).toMatch(/outside allowedPaths/);
  });
});
