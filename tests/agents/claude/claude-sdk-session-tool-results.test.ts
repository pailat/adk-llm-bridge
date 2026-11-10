import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  claudeConfigDir,
  claudeSessionToolResultsDir,
  isSessionToolResultsRead,
} from "../../../src/agents/driver/claude-session-files.js";
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

describe("claudeConfigDir", () => {
  test("CLAUDE_CONFIG_DIR wins; HOME/.claude otherwise", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe("/c");
    expect(claudeConfigDir({ HOME: "/h" })).toBe(join("/h", ".claude"));
    expect(claudeConfigDir({})).toBe(join(homedir(), ".claude"));
  });

  test("a relative CLAUDE_CONFIG_DIR or HOME gives no directory", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "rel" })).toBeUndefined();
    expect(claudeConfigDir({ HOME: "rel" })).toBeUndefined();
  });
});

describe("claudeSessionToolResultsDir", () => {
  test("derives <project>/<session>/tool-results from the runtime's transcript", () => {
    const f = fixture();
    expect(
      claudeSessionToolResultsDir({
        sessionId: SESSION,
        hookSessionId: SESSION,
        transcriptPath: f.transcript,
        configDir: f.config,
      }),
    ).toBe(f.own);
  });

  test.each([
    ["no session from system/init", { sessionId: undefined }],
    ["a session id that is not a UUID", { sessionId: "../x" }],
    ["the hook reports another session", { hookSessionId: OTHER_SESSION }],
    ["no config dir", { configDir: undefined }],
    ["no transcript path", { transcriptPath: undefined }],
    ["a transcript path that is not a string", { transcriptPath: 42 }],
    [
      "a relative transcript path",
      { transcriptPath: `-repo/${SESSION}.jsonl` },
    ],
  ] as const)("fails closed: %s", (_label, override) => {
    const f = fixture();
    expect(
      claudeSessionToolResultsDir({
        sessionId: SESSION,
        hookSessionId: SESSION,
        transcriptPath: f.transcript,
        configDir: f.config,
        ...override,
      }),
    ).toBeUndefined();
  });

  test("fails closed for a session id that is not a UUID, even when every part agrees", () => {
    const f = fixture();
    const id = "not-a-uuid";
    mkdirSync(join(f.project, id, "tool-results"), { recursive: true });
    expect(
      claudeSessionToolResultsDir({
        sessionId: id,
        hookSessionId: id,
        transcriptPath: join(f.project, `${id}.jsonl`),
        configDir: f.config,
      }),
    ).toBeUndefined();
  });

  test.each([
    ["a prefix", `x${SESSION}`],
    ["a suffix", `${SESSION}x`],
    ["a trailing newline", `${SESSION}\n`],
  ])(
    "fails closed for a session id with a UUID and %s, even when every part agrees",
    (_label, id) => {
      const f = fixture();
      mkdirSync(join(f.project, id, "tool-results"), { recursive: true });
      expect(
        claudeSessionToolResultsDir({
          sessionId: id,
          hookSessionId: id,
          transcriptPath: join(f.project, `${id}.jsonl`),
          configDir: f.config,
        }),
      ).toBeUndefined();
    },
  );

  test("fails closed for a relative transcript path, even one that resolves to the right place from /", () => {
    const f = fixture();
    expect(
      claudeSessionToolResultsDir({
        sessionId: SESSION,
        hookSessionId: SESSION,
        transcriptPath: relative("/", f.transcript),
        configDir: f.config,
      }),
    ).toBeUndefined();
  });

  test("fails closed for a transcript of another session or outside <config>/projects/<project>", () => {
    const f = fixture();
    const derive = (transcriptPath: string) =>
      claudeSessionToolResultsDir({
        sessionId: SESSION,
        hookSessionId: SESSION,
        transcriptPath,
        configDir: f.config,
      });
    expect(derive(join(f.project, `${OTHER_SESSION}.jsonl`))).toBeUndefined();
    expect(
      derive(join(f.config, "projects", `${SESSION}.jsonl`)),
    ).toBeUndefined();
    expect(
      derive(join(f.project, "nested", `${SESSION}.jsonl`)),
    ).toBeUndefined();
    expect(
      derive(join(f.base, "elsewhere", `${SESSION}.jsonl`)),
    ).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "fails closed when the session or tool-results dir is a symlink",
    () => {
      const f = fixture();
      const project = join(f.config, "projects", "-linked");
      mkdirSync(project, { recursive: true });
      symlinkSync("/", join(project, SESSION));
      expect(
        claudeSessionToolResultsDir({
          sessionId: SESSION,
          hookSessionId: SESSION,
          transcriptPath: join(project, `${SESSION}.jsonl`),
          configDir: f.config,
        }),
      ).toBeUndefined();
      const project2 = join(f.config, "projects", "-linked2");
      mkdirSync(join(project2, SESSION), { recursive: true });
      symlinkSync("/", join(project2, SESSION, "tool-results"));
      expect(
        claudeSessionToolResultsDir({
          sessionId: SESSION,
          hookSessionId: SESSION,
          transcriptPath: join(project2, `${SESSION}.jsonl`),
          configDir: f.config,
        }),
      ).toBeUndefined();
    },
  );
});

describe("isSessionToolResultsRead", () => {
  test("only Read of a file inside the directory, with Read's own keys", () => {
    const f = fixture();
    const file = join(f.own, "big.txt");
    const check = (tool: string, input: Record<string, unknown>) =>
      isSessionToolResultsRead(f.own, tool, input, f.work);
    expect(check("Read", { file_path: file })).toBe(true);
    expect(check("Read", { file_path: file, offset: 1, limit: 5 })).toBe(true);
    expect(check("Write", { file_path: file })).toBe(false);
    expect(check("read", { file_path: file })).toBe(false);
    expect(check("Grep", { path: f.own })).toBe(false);
    expect(check("Read", { file_path: f.own })).toBe(false);
    expect(check("Read", { file_path: join(f.other, "big.txt") })).toBe(false);
    expect(check("Read", { file_path: join(f.own, "..", "..", "x") })).toBe(
      false,
    );
    expect(check("Read", { file_path: file, path: "/etc/passwd" })).toBe(false);
    // A sibling whose name starts with `tool-results` is outside it.
    const session = join(f.own, "..");
    mkdirSync(join(session, "tool-results-x"), { recursive: true });
    writeFileSync(join(session, "tool-results-x", "out.txt"), "sibling");
    writeFileSync(join(session, "tool-resultsx.txt"), "sibling");
    expect(
      check("Read", { file_path: join(session, "tool-results-x", "out.txt") }),
    ).toBe(false);
    expect(
      check("Read", { file_path: join(session, "tool-resultsx.txt") }),
    ).toBe(false);
    expect(check("Read", {})).toBe(false);
    expect(
      isSessionToolResultsRead(undefined, "Read", { file_path: file }, f.work),
    ).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a symlink inside the directory that points out is refused",
    () => {
      const f = fixture();
      symlinkSync("/etc/hosts", join(f.own, "escape.txt"));
      expect(
        isSessionToolResultsRead(
          f.own,
          "Read",
          { file_path: join(f.own, "escape.txt") },
          f.work,
        ),
      ).toBe(false);
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "Claude Agent SDK under allowedPaths reads its own session's tool results",
  () => {
    test("Read of the own session's persisted output succeeds without asking the host", async () => {
      const f = fixture();
      const { outcomes, hostAsked } = await run(
        [{ tool: "Read", input: { file_path: join(f.own, "big.txt") } }],
        f,
      );
      expect(outcomes).toEqual(["Read:own output"]);
      expect(hostAsked).toEqual([]);
    });

    test("the allowance holds when the host would deny every prompt", async () => {
      const f = fixture();
      const { outcomes } = await run(
        [{ tool: "Read", input: { file_path: join(f.own, "big.txt") } }],
        f,
        { host: async () => ({ behavior: "deny", message: "no" }) },
      );
      expect(outcomes).toEqual(["Read:own output"]);
    });

    test("Read of another session's tool results is denied", async () => {
      const f = fixture();
      const { outcomes } = await run(
        [{ tool: "Read", input: { file_path: join(f.other, "big.txt") } }],
        f,
      );
      expect(outcomes).toEqual(["Read:hook-denied"]);
    });

    test("Write into the own tool-results dir is denied and nothing is written", async () => {
      const f = fixture();
      const target = join(f.own, "planted.txt");
      const { outcomes } = await run(
        [{ tool: "Write", input: { file_path: target } }],
        f,
      );
      expect(outcomes).toEqual(["Write:hook-denied"]);
      expect(() => readFileSync(target)).toThrow();
    });

    test("a hook input naming another session or transcript gets no allowance", async () => {
      const f = fixture();
      const file = join(f.own, "big.txt");
      const { outcomes } = await run(
        [
          {
            tool: "Read",
            input: { file_path: file },
            hook: { session_id: OTHER_SESSION },
          },
          {
            tool: "Read",
            input: { file_path: file },
            hook: {
              transcript_path: join(f.project, `${OTHER_SESSION}.jsonl`),
            },
          },
        ],
        f,
      );
      expect(outcomes).toEqual(["Read:hook-denied", "Read:hook-denied"]);
    });

    test("a session that system/init did not report gets no allowance", async () => {
      const f = fixture();
      const { outcomes } = await run(
        [
          {
            tool: "Read",
            input: { file_path: join(f.other, "big.txt") },
            hook: {
              session_id: OTHER_SESSION,
              transcript_path: join(f.project, `${OTHER_SESSION}.jsonl`),
            },
          },
        ],
        f,
      );
      expect(outcomes).toEqual(["Read:hook-denied"]);
    });

    test("another config dir than the runtime's gets no allowance", async () => {
      const f = fixture();
      const { outcomes } = await run(
        [{ tool: "Read", input: { file_path: join(f.own, "big.txt") } }],
        f,
        { configDir: join(f.base, "other-config") },
      );
      expect(outcomes).toEqual(["Read:hook-denied"]);
    });

    test("the permission callback answers only the Read the hook allowed", async () => {
      const f = fixture();
      writeFileSync(join(f.work, "in.txt"), "inside");
      // Every call is asked about: a Read inside allowedPaths still reaches
      // the host, the session read does not.
      const { outcomes, hostAsked } = await run(
        [
          { tool: "Read", input: { file_path: join(f.work, "in.txt") } },
          { tool: "Read", input: { file_path: join(f.own, "big.txt") } },
          { tool: "Write", input: { file_path: join(f.work, "w.txt") } },
        ],
        f,
        { askAll: true },
      );
      expect(outcomes).toEqual([
        "Read:inside",
        "Read:own output",
        "Write:written",
      ]);
      expect(hostAsked).toEqual(["Read", "Write"]);
    });

    test("the permission callback ties the allowance to the call the hook checked", async () => {
      const f = fixture();
      const file = join(f.own, "big.txt");
      const { outcomes, hostAsked } = await run(
        [
          // Allowed by the hook, approved by the runtime without a prompt.
          { tool: "Read", input: { file_path: file }, noAsk: true },
          // A prompt for a call the hook never checked goes to the host.
          { tool: "Read", input: { file_path: file }, skipHooks: true },
        ],
        f,
        { host: async () => ({ behavior: "deny", message: "no" }) },
      );
      expect(outcomes).toEqual(["Read:own output", "Read:denied"]);
      expect(hostAsked).toEqual(["Read"]);
    });

    test("a prompt whose input differs from what the hook checked goes to the host", async () => {
      const f = fixture();
      const own = join(f.own, "big.txt");
      const { outcomes, hostAsked } = await run(
        [
          {
            tool: "Read",
            input: { file_path: own },
            askInput: { file_path: join(f.other, "big.txt") },
            blockedPath: own,
          },
        ],
        f,
        { host: async () => ({ behavior: "deny", message: "no" }) },
      );
      expect(outcomes).toEqual(["Read:denied"]);
      expect(hostAsked).toEqual(["Read"]);
    });

    test("a prompt whose blockedPath is outside the directory goes to the host", async () => {
      const f = fixture();
      const { outcomes, hostAsked } = await run(
        [
          {
            tool: "Read",
            input: { file_path: join(f.own, "big.txt") },
            blockedPath: join(f.other, "big.txt"),
          },
        ],
        f,
        { host: async () => ({ behavior: "deny", message: "no" }) },
      );
      expect(outcomes).toEqual(["Read:denied"]);
      expect(hostAsked).toEqual(["Read"]);
    });

    test("read-only with allowedPaths: the session read runs, other prompts stay denied", async () => {
      const f = fixture();
      const { outcomes } = await run(
        [{ tool: "Read", input: { file_path: join(f.own, "big.txt") } }],
        f,
        {
          askAll: true,
          permissions: { mode: "read-only", allowedPaths: [f.work] },
          host: async () => ({ behavior: "deny", message: "read-only" }),
        },
      );
      expect(outcomes).toEqual(["Read:own output"]);
    });

    test("without allowedPaths nothing changes: an outside Read goes to the host", async () => {
      const f = fixture();
      const { outcomes, hostAsked } = await run(
        [{ tool: "Read", input: { file_path: join(f.own, "big.txt") } }],
        f,
        { permissions: { mode: "workspace-write" } },
      );
      expect(outcomes).toEqual(["Read:own output"]);
      expect(hostAsked).toEqual(["Read"]);
    });
  },
);
