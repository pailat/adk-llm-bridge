import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import type { PermissionDecision } from "../../../src/agents/permissions/confirmation.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/claude.js";

const SESSION = "0f9c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const OTHER_SESSION = "11111111-2222-4333-8444-555555555555";

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
  /** Overrides of the hook input (session id, transcript path). */
  hook?: Record<string, unknown>;
  /** Skip the `PreToolUse` hooks (a call the hook never saw). */
  skipHooks?: boolean;
  /** Run without asking `canUseTool` (Claude Code approved it on its own). */
  noAsk?: boolean;
  /** The `blockedPath` the runtime reports to `canUseTool`. */
  blockedPath?: string;
  /** The input the runtime passes to `canUseTool`, when not `input`. */
  askInput?: Record<string, unknown>;
}

const CACHE = join(import.meta.dir, "..", "..", "..", "node_modules", ".cache");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * A Claude config dir with one project and two sessions, each with a
 * persisted tool result, and a repo whose `work` dir is the allowed root.
 */
function fixture() {
  mkdirSync(CACHE, { recursive: true });
  const base = realpathSync(mkdtempSync(join(CACHE, "session-files-")));
  dirs.push(base);
  const config = join(base, "config");
  const project = join(config, "projects", "-repo");
  const own = join(project, SESSION, "tool-results");
  const other = join(project, OTHER_SESSION, "tool-results");
  mkdirSync(own, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(own, "big.txt"), "own output");
  writeFileSync(join(other, "big.txt"), "other output");
  writeFileSync(join(project, `${SESSION}.jsonl`), "");
  const work = join(base, "repo", "work");
  mkdirSync(work, { recursive: true });
  return {
    base,
    config,
    project,
    own,
    other,
    work,
    transcript: join(project, `${SESSION}.jsonl`),
  };
}

function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A fake SDK that behaves like Claude Code for reads: `PreToolUse` hooks run
 * first with the runtime's session id and transcript path; a read outside
 * `cwd` and `additionalDirectories` asks `canUseTool` (denied without one);
 * a Write is attempted for real when nothing denies it.
 */
function sdkFor(
  calls: readonly ToolCall[],
  transcript: string,
  initSession = SESSION,
  askAll = false,
) {
  const state = {
    outcomes: [] as string[],
    asked: [] as string[],
  };
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      const options = input.options;
      const cwd = options.cwd as string;
      const extra = (options.additionalDirectories as string[]) ?? [];
      const hooks =
        (options.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> })
          ?.PreToolUse ?? [];
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-haiku-5-5",
          session_id: initSession,
          tools: (options.tools as string[]) ?? [],
          mcp_servers: [],
        };
        let n = 0;
        for (const call of calls) {
          state.outcomes.push(await perform(call, `tu-${n++}`));
        }
        yield { type: "result", subtype: "success", result: "done" };
      })();

      async function perform(call: ToolCall, id: string): Promise<string> {
        for (const matcher of call.skipHooks ? [] : hooks) {
          for (const hook of matcher.hooks) {
            const output = (await hook(
              {
                hook_event_name: "PreToolUse",
                session_id: initSession,
                transcript_path: transcript,
                cwd,
                tool_name: call.tool,
                tool_input: call.input,
                tool_use_id: id,
                ...call.hook,
              },
              id,
              { signal: new AbortController().signal },
            )) as { hookSpecificOutput?: { permissionDecision?: string } };
            if (output.hookSpecificOutput?.permissionDecision === "deny") {
              return `${call.tool}:hook-denied`;
            }
          }
        }
        const path = String(call.input.file_path);
        if (
          !call.noAsk &&
          (askAll || ![cwd, ...extra].some((root) => under(path, root)))
        ) {
          state.asked.push(id);
          const decision = canUseTool
            ? await canUseTool(call.tool, call.askInput ?? call.input, {
                toolUseID: id,
                blockedPath: call.blockedPath ?? path,
              })
            : { behavior: "deny" };
          if (decision.behavior !== "allow") return `${call.tool}:denied`;
        }
        if (call.tool === "Read") {
          return `Read:${readFileSync(path, "utf8")}`;
        }
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

async function run(
  calls: ToolCall[],
  f: ReturnType<typeof fixture>,
  options: {
    permissions?: ExternalAgentPermissionPolicy;
    configDir?: string;
    initSession?: string;
    host?: (request: { toolName: string }) => Promise<PermissionDecision>;
    withHost?: boolean;
    askAll?: boolean;
  } = {},
) {
  const { sdk, state } = sdkFor(
    calls,
    f.transcript,
    options.initSession,
    options.askAll,
  );
  const asked: string[] = [];
  const request: ExternalAgentRunRequest = {
    provider: CLAUDE_PROVIDER,
    context: { input: "probe" } as never,
    instruction: "probe",
    workingDirectory: f.work,
    permissions: options.permissions ?? {
      mode: "workspace-write",
      allowedPaths: [f.work],
    },
    ...(options.withHost === false
      ? {}
      : {
          requestPermission: async (req: { toolName: string }) => {
            asked.push(req.toolName);
            return options.host
              ? options.host(req)
              : ({ behavior: "allow" } as PermissionDecision);
          },
        }),
  };
  await collect(
    new ClaudeAgentSdkDriver({
      sdk: sdk as never,
      tools: ["Read", "Write"],
      env: {
        PATH: process.env.PATH,
        CLAUDE_CONFIG_DIR: options.configDir ?? f.config,
      },
    }).run(request as never),
  );
  return { outcomes: state.outcomes, hostAsked: asked };
}

function withRef(f: ReturnType<typeof fixture>) {
  const ref = join(f.base, "repo", "ref");
  mkdirSync(ref, { recursive: true });
  writeFileSync(join(ref, "doc.txt"), "ref doc");
  return ref;
}

describe("INTEG: readPaths + own session tool-results", () => {
  test("host present: readPaths read and own tool-results read allowed without host; other session, writes to readPaths and to tool-results denied", async () => {
    const f = fixture();
    const ref = withRef(f);
    const { outcomes, hostAsked } = await run(
      [
        { tool: "Read", input: { file_path: join(ref, "doc.txt") } },
        { tool: "Read", input: { file_path: join(f.own, "big.txt") } },
        { tool: "Read", input: { file_path: join(f.other, "big.txt") } },
        { tool: "Write", input: { file_path: join(ref, "w.txt") } },
        { tool: "Write", input: { file_path: join(f.own, "w.txt") } },
      ],
      f,
      {
        permissions: {
          mode: "workspace-write",
          allowedPaths: [f.work],
          readPaths: [ref],
        },
        host: async () => ({ behavior: "deny", message: "no" }),
      },
    );
    expect(outcomes).toEqual([
      "Read:ref doc",
      "Read:own output",
      "Read:hook-denied",
      "Write:hook-denied",
      "Write:hook-denied",
    ]);
    expect(hostAsked).toEqual([]);
  });

  test("no host + readPaths: RP1 callback is wrapped by SEC; own tool-results read works, the rest stays denied", async () => {
    const f = fixture();
    const ref = withRef(f);
    const outside = join(f.base, "repo", "outside.txt");
    writeFileSync(outside, "outside");
    const { outcomes } = await run(
      [
        { tool: "Read", input: { file_path: join(ref, "doc.txt") } },
        { tool: "Read", input: { file_path: join(f.own, "big.txt") } },
        { tool: "Read", input: { file_path: join(f.other, "big.txt") } },
        { tool: "Read", input: { file_path: outside } },
        { tool: "Read", input: { file_path: outside }, skipHooks: true },
      ],
      f,
      {
        permissions: {
          mode: "workspace-write",
          allowedPaths: [f.work],
          readPaths: [ref],
        },
        withHost: false,
      },
    );
    expect(outcomes).toEqual([
      "Read:ref doc",
      "Read:own output",
      "Read:hook-denied",
      "Read:hook-denied",
      "Read:denied",
    ]);
  });

  test("read-only + readPaths, host denies all: only the readPaths read and the own tool-results read run", async () => {
    const f = fixture();
    const ref = withRef(f);
    const { outcomes } = await run(
      [
        { tool: "Read", input: { file_path: join(ref, "doc.txt") } },
        { tool: "Read", input: { file_path: join(f.own, "big.txt") } },
        {
          tool: "Write",
          input: { file_path: join(f.work, "w.txt") },
          askAll: true,
        } as never,
      ],
      f,
      {
        permissions: {
          mode: "read-only",
          allowedPaths: [f.work],
          readPaths: [ref],
        },
        host: async () => ({ behavior: "deny", message: "no" }),
        askAll: true,
      },
    );
    expect(outcomes.slice(0, 2)).toEqual(["Read:ref doc", "Read:own output"]);
    expect(outcomes[2]).not.toBe("Write:written");
  });

  test("a SEC-allowed call id cannot be reused for a readPaths-outside read in the callback", async () => {
    const f = fixture();
    const ref = withRef(f);
    const outside = join(f.base, "repo", "outside.txt");
    writeFileSync(outside, "outside");
    const { outcomes } = await run(
      [
        {
          tool: "Read",
          input: { file_path: join(f.own, "big.txt") },
          askInput: { file_path: outside },
          blockedPath: outside,
        },
      ],
      f,
      {
        permissions: {
          mode: "workspace-write",
          allowedPaths: [f.work],
          readPaths: [ref],
        },
        host: async () => ({ behavior: "deny", message: "no" }),
        askAll: true,
      },
    );
    expect(outcomes).toEqual(["Read:denied"]);
  });

  test("readPathBounds-only policy: own tool-results read allowed, reads outside the bounds denied", async () => {
    const f = fixture();
    const ref = withRef(f);
    const outside = join(f.base, "repo", "outside.txt");
    writeFileSync(outside, "outside");
    const { outcomes } = await run(
      [
        { tool: "Read", input: { file_path: join(f.own, "big.txt") } },
        { tool: "Read", input: { file_path: outside } },
        { tool: "Read", input: { file_path: join(f.other, "big.txt") } },
      ],
      f,
      {
        permissions: {
          mode: "workspace-write",
          readPathBounds: [[f.work, ref]],
        } as never,
      },
    );
    expect(outcomes).toEqual([
      "Read:own output",
      "Read:hook-denied",
      "Read:hook-denied",
    ]);
  });
});
