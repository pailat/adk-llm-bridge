import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawnOptions,
} from "../../../src/agents/driver/claude-cli.js";
import {
  CLAUDE_DISABLE_BACKGROUND_TASKS_ENV,
  ClaudeBackgroundTaskTracker,
  createClaudeRunTempDir,
} from "../../../src/agents/driver/claude-run-env.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { EXTERNAL_AGENT_BACKGROUND_TASK_PENDING } from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const REQUEST = {
  provider: CLAUDE_PROVIDER,
  context: {} as never,
  instruction: "Run the mutants.",
};

const INIT = { type: "system", subtype: "init", model: "claude-test" };
const RESULT = {
  type: "result",
  subtype: "success",
  result: "The first mutant is running.",
  session_id: "s-1",
};

function tasksChanged(
  tasks: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return { type: "system", subtype: "background_tasks_changed", tasks };
}

const BASH_TASK = {
  task_id: "b1",
  task_type: "local_bash",
  description: "bun test mutants",
};

async function collect(
  events: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const out: ExternalAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function sdkDriver(
  messages: readonly unknown[],
  config: { allowBackgroundTasks?: boolean } = {},
  onOptions?: (options: Record<string, unknown>) => void,
): ClaudeAgentSdkDriver {
  return new ClaudeAgentSdkDriver({
    env: { PATH: "/bin" },
    pathToClaudeCodeExecutable: "/fake/claude",
    ...config,
    sdk: {
      query: ({ options }) => {
        onOptions?.(options as Record<string, unknown>);
        return (async function* () {
          for (const message of messages) yield message as never;
        })() as never;
      },
    },
  });
}

function cliDriver(
  lines: readonly unknown[],
  config: { allowBackgroundTasks?: boolean } = {},
  onSpawn?: (options: ClaudeCliSpawnOptions) => void,
  exitCode = 0,
): ClaudeCliDriver {
  return new ClaudeCliDriver({
    env: { PATH: "/bin" },
    ...config,
    spawn: (_command, _args, options) => {
      onSpawn?.(options);
      return {
        stdout: lines.map((line) => `${JSON.stringify(line)}\n`),
        stderr: [],
        exited: Promise.resolve(exitCode),
      };
    },
  });
}

describe("background tasks are off for headless Claude runs", () => {
  test("the SDK driver sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 by default", () => {
    const env = sdkDriver([]).buildEnv(REQUEST);
    expect(CLAUDE_DISABLE_BACKGROUND_TASKS_ENV).toBe(
      "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
    );
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });

  test("the CLI driver sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 by default", () => {
    const env = cliDriver([]).buildEnv(REQUEST);
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });

  test("a credential cannot turn background tasks back on", () => {
    const request = {
      ...REQUEST,
      // A provider whose allowlist would forward the variable.
      provider: {
        ...CLAUDE_PROVIDER,
        envAllowlist: [
          ...(CLAUDE_PROVIDER.envAllowlist ?? []),
          "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
        ],
      },
      credential: {
        kind: "env" as const,
        env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" },
      },
    };
    expect(
      sdkDriver([]).buildEnv(request).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    ).toBe("1");
    expect(
      cliDriver([]).buildEnv(request).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    ).toBe("1");
  });

  test("allowBackgroundTasks: true leaves the variable unset", () => {
    expect(
      sdkDriver([], { allowBackgroundTasks: true }).buildEnv(REQUEST),
    ).not.toHaveProperty("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS");
    expect(
      cliDriver([], { allowBackgroundTasks: true }).buildEnv(REQUEST),
    ).not.toHaveProperty("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS");
  });

  test("the SDK query receives the variable", async () => {
    let env: Record<string, string | undefined> | undefined;
    await collect(
      sdkDriver([INIT, RESULT], {}, (options) => {
        env = options.env as Record<string, string | undefined>;
      }).run(REQUEST),
    );
    expect(env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });
});

describe("a run that ends with a background task still running fails", () => {
  for (const [name, run] of [
    ["SDK", (messages: readonly unknown[]) => sdkDriver(messages).run(REQUEST)],
    ["CLI", (messages: readonly unknown[]) => cliDriver(messages).run(REQUEST)],
  ] as const) {
    test(`${name}: a live task at the result is a typed error, exit code 1`, async () => {
      const events = await collect(
        run([INIT, tasksChanged([BASH_TASK]), RESULT]),
      );
      const error = events.find((event) => event.type === "error");
      expect(error).toMatchObject({
        type: "error",
        code: EXTERNAL_AGENT_BACKGROUND_TASK_PENDING,
        recoverable: false,
      });
      expect(error?.type === "error" && error.message).toContain(
        "b1 (local_bash: bun test mutants)",
      );
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
      expect(EXTERNAL_AGENT_BACKGROUND_TASK_PENDING).toBe(
        "EXTERNAL_AGENT_BACKGROUND_TASK_PENDING",
      );
    });

    test(`${name}: a task that finished before the result is fine`, async () => {
      const events = await collect(
        run([INIT, tasksChanged([BASH_TASK]), tasksChanged([]), RESULT]),
      );
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    });

    test(`${name}: ambient tasks do not count`, async () => {
      const events = await collect(
        run([INIT, tasksChanged([{ ...BASH_TASK, ambient: true }]), RESULT]),
      );
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    });
  }

  test("SDK: a stream that ends without a result while a task runs fails", async () => {
    const events = await collect(
      sdkDriver([INIT, tasksChanged([BASH_TASK])]).run(REQUEST),
    );
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: EXTERNAL_AGENT_BACKGROUND_TASK_PENDING,
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("SDK: an error result keeps its own error, not a second one", async () => {
    const events = await collect(
      sdkDriver([
        INIT,
        tasksChanged([BASH_TASK]),
        { type: "result", subtype: "error_max_turns", errors: ["max turns"] },
      ]).run(REQUEST),
    );
    expect(
      events.filter((event) => event.type === "error").map((e) => e.code),
    ).toEqual(["MAX_TURNS_EXCEEDED"]);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("the message lists at most five tasks", async () => {
    const tasks = Array.from({ length: 7 }, (_, index) => ({
      task_id: `t${index}`,
      task_type: "local_agent",
      description: "",
    }));
    const events = await collect(
      sdkDriver([INIT, tasksChanged(tasks), RESULT]).run(REQUEST),
    );
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.message).toContain(
      "7 background tasks were still running (t0 (local_agent), t1 (local_agent), t2 (local_agent), t3 (local_agent), t4 (local_agent) and 2 more)",
    );
  });

  test("the tracker replaces its set on each message and ignores others", () => {
    const tracker = new ClaudeBackgroundTaskTracker();
    tracker.observe(tasksChanged([BASH_TASK, { task_id: "b2" }]));
    expect(tracker.pending().map((task) => task.id)).toEqual(["b1", "b2"]);
    tracker.observe({ type: "system", subtype: "init", tasks: [] });
    tracker.observe({ type: "assistant", subtype: "background_tasks_changed" });
    expect(tracker.pending()).toHaveLength(2);
    tracker.observe(tasksChanged([{ task_id: "b2" }]));
    expect(tracker.pending()).toEqual([
      { id: "b2", type: "unknown", description: "" },
    ]);
  });
});

describe("each Claude run gets a private temp directory", () => {
  if (process.platform === "win32") return;

  function expectPrivate(env: Record<string, string | undefined>) {
    const root = env.CLAUDE_CODE_TMPDIR;
    const tmp = env.TMPDIR;
    expect(root).toBeDefined();
    expect(tmp).toBe(join(root as string, `claude-${process.getuid?.()}`));
    for (const path of [root as string, tmp as string]) {
      const stat = statSync(path);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(stat.uid).toBe(process.getuid?.() as number);
    }
    // Real paths: the sandbox's write rules match canonical paths, and on
    // macOS /tmp is a symlink to /private/tmp.
    expect(root).toBe(realpathSync(root as string));
    expect(tmp).toBe(realpathSync(tmp as string));
    if (process.platform === "darwin") {
      expect(root?.startsWith("/private/tmp/")).toBe(true);
      expect(tmp?.startsWith("/private/tmp/")).toBe(true);
    }
    // Short, so Claude Code hands it to shell commands as their TMPDIR.
    expect(Buffer.byteLength(tmp as string)).toBeLessThanOrEqual(44);
    // Not the shared host temp directory itself.
    expect(root).not.toBe(tmpdir());
    return root as string;
  }

  test("SDK: exists during the run, removed after it", async () => {
    let root: string | undefined;
    await collect(
      sdkDriver([INIT, RESULT], {}, (options) => {
        root = expectPrivate(options.env as Record<string, string | undefined>);
      }).run(REQUEST),
    );
    expect(root).toBeDefined();
    expect(existsSync(root as string)).toBe(false);
  });

  test("SDK: removed after a failed run too", async () => {
    let root: string | undefined;
    const driver = new ClaudeAgentSdkDriver({
      env: { PATH: "/bin" },
      pathToClaudeCodeExecutable: "/fake/claude",
      sdk: {
        query: ({ options }) => {
          root = options?.env?.CLAUDE_CODE_TMPDIR;
          // biome-ignore lint/correctness/useYield: fails before any message
          return (async function* () {
            throw new Error("boom");
          })() as never;
        },
      },
    });
    const events = await collect(driver.run(REQUEST));
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    expect(root).toBeDefined();
    expect(existsSync(root as string)).toBe(false);
  });

  test("CLI: exists during the run, removed after it", async () => {
    let root: string | undefined;
    await collect(
      cliDriver([INIT, RESULT], {}, (options) => {
        root = expectPrivate(options.env ?? {});
      }).run(REQUEST),
    );
    expect(root).toBeDefined();
    expect(existsSync(root as string)).toBe(false);
  });

  test("CLI: removed when the run fails", async () => {
    let root: string | undefined;
    await collect(
      cliDriver(
        [INIT],
        {},
        (options) => {
          root = options.env?.CLAUDE_CODE_TMPDIR;
        },
        2,
      ).run(REQUEST),
    );
    expect(root).toBeDefined();
    expect(existsSync(root as string)).toBe(false);
  });

  test("two directories are never the same", () => {
    const first = createClaudeRunTempDir();
    const second = createClaudeRunTempDir();
    try {
      expect(first?.env.CLAUDE_CODE_TMPDIR).toBeDefined();
      expect(first?.env.CLAUDE_CODE_TMPDIR).not.toBe(
        second?.env.CLAUDE_CODE_TMPDIR,
      );
    } finally {
      first?.dispose();
      second?.dispose();
    }
    expect(existsSync(first?.env.CLAUDE_CODE_TMPDIR as string)).toBe(false);
  });

  test("the confinement check is unchanged: allowedPaths under /tmp stay refused", () => {
    const driver = new ClaudeAgentSdkDriver({ env: { PATH: "/bin" } });
    const plan = driver.isolationPlan({
      ...REQUEST,
      workingDirectory: "/tmp",
      permissions: { mode: "workspace-write", allowedPaths: ["/tmp"] },
    });
    expect(plan.shellPathsUnenforceable).toContain("temp directory");
  });
});
