import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { EXTERNAL_AGENT_PATHS_UNENFORCEABLE } from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
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
  options: { toolUseID?: string },
) => Promise<{ behavior: string }>;

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The temp area the Claude Code sandbox keeps writable whatever allowWrite says. */
const ALWAYS_WRITABLE = [realpathSync(tmpdir()), realpathSync("/tmp")];

function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A fake Claude Agent SDK that applies the options the bridge passes the way
 * Claude Code does, and performs the writes for real:
 * - `PreToolUse` hooks run first, in every mode; a deny stops the call;
 * - `acceptEdits` approves edit tools inside `cwd` and `additionalDirectories`
 *   without `canUseTool`, `bypassPermissions` approves everything, and any
 *   other call goes to `canUseTool` (denied without one);
 * - Bash `echo x > <path>` writes only inside `cwd`,
 *   `sandbox.filesystem.allowWrite` and the temp area Claude Code always keeps
 *   writable (`os.tmpdir()` and `/tmp` here) when the sandbox is on;
 * - Glob and Grep that pass the hook search (read) without asking.
 */
function confiningSdk(calls: readonly ToolCall[]) {
  const state = {
    started: false,
    outcomes: [] as string[],
    options: undefined as Record<string, unknown> | undefined,
  };
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      state.started = true;
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
        if (call.tool === "Glob" || call.tool === "Grep") {
          return `${call.tool}:searched`;
        }
        const path = String(
          call.input.file_path ??
            /> (\S+)/u.exec(String(call.input.command))?.[1],
        );
        const autoApproved =
          mode === "bypassPermissions" ||
          (mode === "acceptEdits" &&
            EDIT_TOOLS.has(call.tool) &&
            [cwd, ...extra].some((root) => under(path, root)));
        if (!autoApproved) {
          const decision = canUseTool
            ? await canUseTool(call.tool, call.input, { toolUseID: "tu" })
            : { behavior: "deny" };
          if (decision.behavior !== "allow") return `${call.tool}:denied`;
        }
        if (call.tool === "Bash" && sandbox?.enabled) {
          const writable = [
            cwd,
            ...(sandbox.filesystem?.allowWrite ?? []),
            ...ALWAYS_WRITABLE,
          ];
          if (!writable.some((root) => under(path, root))) {
            return `${call.tool}:sandbox-denied`;
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

const CACHE = join(import.meta.dir, "..", "..", "..", "node_modules", ".cache");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * A repo with `lib/data`. By default outside every temp directory (under the
 * git-ignored `node_modules/.cache`), because a repo inside the sandbox's
 * always-writable temp area is refused.
 */
function repo(parent = CACHE): string {
  mkdirSync(parent, { recursive: true });
  const base = realpathSync(mkdtempSync(join(parent, "confinement-")));
  dirs.push(base);
  mkdirSync(join(base, "lib", "data"), { recursive: true });
  return base;
}

function run(
  calls: ToolCall[],
  permissions: ExternalAgentPermissionPolicy,
  workingDirectory: string,
  tools: string[] = ["Write", "Bash"],
  driverOptions: { inheritHostConfig?: boolean } = {},
) {
  const { sdk, state } = confiningSdk(calls);
  const request: ExternalAgentRunRequest = {
    provider: CLAUDE_PROVIDER,
    context: { input: "probe" } as never,
    instruction: "probe",
    workingDirectory,
    permissions,
    // The host answers prompts and would approve everything; only the policy
    // may deny.
    requestPermission: async () => ({ behavior: "allow" }),
  };
  const events = collect(
    new ClaudeAgentSdkDriver({
      sdk: sdk as never,
      tools,
      ...driverOptions,
    }).run(request),
  );
  return { events, state };
}

describe.skipIf(process.platform === "win32")(
  "Claude Agent SDK keeps workspace-write inside allowedPaths",
  () => {
    test("the live probe: cwd is the repo, allowedPaths is lib/data; nothing is written outside", async () => {
      const root = repo();
      const { events, state } = run(
        [
          { tool: "Write", input: { file_path: join(root, "app", "x.txt") } },
          {
            tool: "Bash",
            input: { command: `echo x > ${join(root, "components", "x.txt")}` },
          },
        ],
        { mode: "workspace-write", allowedPaths: [join(root, "lib", "data")] },
        root,
      );
      const result = await events;
      expect(existsSync(join(root, "app", "x.txt"))).toBe(false);
      expect(existsSync(join(root, "components", "x.txt"))).toBe(false);
      // The sandbox always lets Bash write to the working directory, so the
      // run is refused before it starts.
      expect(state.started).toBe(false);
      expect(result.find((event) => event.type === "error")).toMatchObject({
        code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
        recoverable: false,
      });
    });

    test("cwd inside allowedPaths: Write and Bash outside are denied, inside are written", async () => {
      const root = repo();
      const data = join(root, "lib", "data");
      const { events, state } = run(
        [
          { tool: "Write", input: { file_path: join(root, "app", "x.txt") } },
          {
            tool: "Bash",
            input: { command: `echo x > ${join(root, "components", "x.txt")}` },
          },
          { tool: "Write", input: { file_path: join(data, "in.txt") } },
          {
            tool: "Bash",
            input: { command: `echo x > ${join(data, "in-bash.txt")}` },
          },
        ],
        { mode: "workspace-write", allowedPaths: [data] },
        data,
      );
      await events;
      expect(state.outcomes).toEqual([
        "Write:hook-denied",
        "Bash:sandbox-denied",
        "Write:written",
        "Bash:written",
      ]);
      expect(existsSync(join(root, "app", "x.txt"))).toBe(false);
      expect(existsSync(join(root, "components", "x.txt"))).toBe(false);
    });

    test("an edit Claude Code auto-approves inside cwd is still checked (every edit tool)", async () => {
      const root = repo();
      const data = join(root, "lib", "data");
      const calls = ["Write", "Edit", "MultiEdit"].map((tool) => ({
        tool,
        input: { file_path: join(root, `${tool}.txt`) },
      }));
      calls.push({
        tool: "NotebookEdit",
        input: { notebook_path: join(root, "n.ipynb") } as never,
      });
      const { events, state } = run(
        calls,
        {
          mode: "workspace-write",
          allowedPaths: [data, root],
          pathBounds: [[data]],
        },
        data,
        ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      );
      await events;
      expect(
        state.outcomes.every((outcome) => outcome.endsWith(":hook-denied")),
      ).toBe(true);
    });

    test("allowNetwork: true with Bash and allowedPaths is refused (no sandbox would confine it)", async () => {
      const root = repo();
      const data = join(root, "lib", "data");
      const { events, state } = run(
        [],
        { mode: "workspace-write", allowNetwork: true, allowedPaths: [data] },
        data,
      );
      expect(
        (await events).find((event) => event.type === "error"),
      ).toMatchObject({
        code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
      });
      expect(state.started).toBe(false);
    });

    test("without a shell tool, a cwd outside allowedPaths is fine: the hook checks edits", async () => {
      const root = repo();
      const data = join(root, "lib", "data");
      const { events, state } = run(
        [{ tool: "Write", input: { file_path: join(root, "app", "x.txt") } }],
        { mode: "workspace-write", allowedPaths: [data] },
        root,
        ["Write"],
      );
      await events;
      expect(state.outcomes).toEqual(["Write:hook-denied"]);
    });

    test("Glob and Grep without a path search the working directory, so they are checked against it", async () => {
      const root = repo();
      const data = join(root, "lib", "data");
      const calls: ToolCall[] = [
        { tool: "Glob", input: { pattern: "**/*" } },
        { tool: "Glob", input: { pattern: "*.env" } },
        { tool: "Grep", input: { pattern: "secret" } },
        { tool: "Grep", input: { pattern: "secret", glob: "**/*.ts" } },
        { tool: "Glob", input: { pattern: "**/*", path: data } },
        { tool: "Grep", input: { pattern: "secret", path: data } },
      ];
      const outside = run(
        calls,
        { mode: "workspace-write", allowedPaths: [data] },
        root,
        ["Glob", "Grep"],
      );
      await outside.events;
      expect(outside.state.outcomes).toEqual([
        "Glob:hook-denied",
        "Glob:hook-denied",
        "Grep:hook-denied",
        "Grep:hook-denied",
        "Glob:searched",
        "Grep:searched",
      ]);
      const inside = run(
        calls.slice(0, 4),
        { mode: "workspace-write", allowedPaths: [data] },
        data,
        ["Glob", "Grep"],
      );
      await inside.events;
      expect(
        inside.state.outcomes.every((outcome) => outcome.endsWith(":searched")),
      ).toBe(true);
    });

    test("pathBounds narrow the sandbox's writable roots", async () => {
      const root = repo();
      const src = join(root, "src");
      mkdirSync(src);
      const { events, state } = run(
        [
          {
            tool: "Bash",
            input: { command: `echo x > ${join(root, "x.txt")}` },
          },
          {
            tool: "Bash",
            input: { command: `echo x > ${join(src, "y.txt")}` },
          },
        ],
        { mode: "workspace-write", allowedPaths: [root], pathBounds: [[src]] },
        src,
      );
      await events;
      expect(state.outcomes).toEqual(["Bash:sandbox-denied", "Bash:written"]);
      const sandbox = (state.options?.sandbox ?? {}) as {
        filesystem?: { allowWrite?: string[] };
      };
      expect(sandbox.filesystem?.allowWrite).toEqual([]);
      expect(existsSync(join(root, "x.txt"))).toBe(false);
    });

    test("a repo inside the sandbox's always-writable temp area is refused", async () => {
      for (const parent of ALWAYS_WRITABLE) {
        const root = repo(parent);
        const data = join(root, "lib", "data");
        const { events, state } = run(
          [
            {
              tool: "Bash",
              input: {
                command: `echo x > ${join(root, "components", "x.txt")}`,
              },
            },
          ],
          { mode: "workspace-write", allowedPaths: [data] },
          data,
        );
        expect(
          (await events).find((event) => event.type === "error"),
        ).toMatchObject({
          code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
          message: expect.stringContaining("temp"),
        });
        expect(state.started).toBe(false);
        expect(existsSync(join(root, "components", "x.txt"))).toBe(false);
      }
    });

    test("inheritHostConfig with Bash and allowedPaths is refused (host settings can widen allowWrite)", async () => {
      const root = repo();
      const data = join(root, "lib", "data");
      const { events, state } = run(
        [],
        { mode: "workspace-write", allowedPaths: [data] },
        data,
        ["Write", "Bash"],
        { inheritHostConfig: true },
      );
      expect(
        (await events).find((event) => event.type === "error"),
      ).toMatchObject({
        code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
        message: expect.stringContaining("inheritHostConfig"),
      });
      expect(state.started).toBe(false);
    });

    test("the path hook denies a call without a tool name", async () => {
      const root = repo();
      const data = join(root, "lib", "data");
      const { events, state } = run(
        [],
        { mode: "workspace-write", allowedPaths: [data] },
        data,
        ["Write"],
        { inheritHostConfig: true },
      );
      await events;
      const hooks =
        (state.options?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> })
          ?.PreToolUse ?? [];
      const outputs = await Promise.all(
        hooks.flatMap((matcher) =>
          matcher.hooks.map((hook) =>
            hook({ hook_event_name: "PreToolUse", tool_input: {} }, "tu", {
              signal: new AbortController().signal,
            }),
          ),
        ),
      );
      expect(outputs).toContainEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("without a name"),
        },
      });
    });
  },
);
