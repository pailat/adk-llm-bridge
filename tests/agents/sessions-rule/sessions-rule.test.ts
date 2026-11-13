import { describe, expect, test } from "bun:test";
import * as agents from "../../../src/agents/index.js";
import {
  CLAUDE_PROVIDER,
  ClaudeAgentSdkDriver,
  ClaudeCliDriver,
  CODEX_PROVIDER,
  CodexCliDriver,
  CodexSdkDriver,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
  FX_PROVIDER,
  FxCliDriver,
} from "../../../src/agents/index.js";
import { noHostMcpServers } from "../helpers.js";

const CODE = "EXTERNAL_AGENT_SESSIONS_UNSUPPORTED";

async function drain(events: AsyncIterable<ExternalAgentEvent>) {
  const collected: ExternalAgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function emptyProcess(counter: { spawned: number }) {
  return () => {
    counter.spawned++;
    const empty = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    return {
      stdout: empty(),
      stderr: empty(),
      exited: Promise.resolve(0),
      kill: () => {},
    };
  };
}

async function* sdkEvents(events: readonly Record<string, unknown>[]) {
  for (const event of events) yield event;
}

function request(
  provider: ExternalAgentRunRequest["provider"],
  extra: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider,
    agent: { name: "agent" } as never,
    context: {
      agent: { name: "agent" },
      session: { state: {}, events: [] },
      userContent: { role: "user", parts: [{ text: "go" }] },
    } as never,
    permissions: { mode: "read-only", allowNetwork: true },
    ...extra,
  };
}

interface Built {
  driver: ExternalAgentDriver;
  /** Process or SDK starts observed so far. */
  started: () => number;
  /** Ids the runtime was asked to resume (only for drivers that resume). */
  resumed: () => string[];
}

function claudeCli(): Built {
  const counter = { spawned: 0 };
  return {
    driver: new ClaudeCliDriver({ spawn: emptyProcess(counter), env: {} }),
    started: () => counter.spawned,
    resumed: () => [],
  };
}
function codexCli(): Built {
  const counter = { spawned: 0 };
  return {
    driver: new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      spawn: emptyProcess(counter),
      env: {},
    }),
    started: () => counter.spawned,
    resumed: () => [],
  };
}
/** fx that does not persist sessions: every run is `--no-save`, so nothing resumes. */
function fxCliStateless(): Built {
  const counter = { spawned: 0 };
  return {
    driver: new FxCliDriver({
      spawn: emptyProcess(counter),
      env: {},
      model: "some/model-id",
      inheritHostConfig: true,
      persistSession: false,
    }),
    started: () => counter.spawned,
    resumed: () => [],
  };
}
/** fx with its default: sessions persist, a run resumes with `--resume-id`. */
function fxCli(): Built {
  const calls = { started: 0, resumed: [] as string[] };
  const process = emptyProcess({ spawned: 0 });
  return {
    driver: new FxCliDriver({
      spawn: (_command, args) => {
        calls.started++;
        const at = args.indexOf("--resume-id");
        if (at !== -1) calls.resumed.push(args[at + 1] as string);
        return process();
      },
      env: {},
      model: "some/model-id",
      inheritHostConfig: true,
    }),
    started: () => calls.started,
    resumed: () => calls.resumed,
  };
}
function codexSdk(): Built {
  const calls = { started: 0, resumed: [] as string[] };
  const thread = (id: string | null) =>
    ({
      id,
      runStreamed: async () => ({
        events: sdkEvents([
          { type: "turn.completed", usage: { input_tokens: 1 } },
        ]),
      }),
    }) as never;
  return {
    driver: new CodexSdkDriver({
      sdk: {
        startThread: () => {
          calls.started++;
          return thread(null);
        },
        resumeThread: (id: string) => {
          calls.resumed.push(id);
          return thread(id);
        },
      },
    }),
    started: () => calls.started + calls.resumed.length,
    resumed: () => calls.resumed,
  };
}
function claudeSdk(): Built {
  const resumed: string[] = [];
  let queries = 0;
  return {
    driver: new ClaudeAgentSdkDriver({
      sdk: {
        query: (params: { options?: { resume?: string } }) => {
          queries++;
          if (params.options?.resume) resumed.push(params.options.resume);
          return sdkEvents([
            {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "ok",
              session_id: "sdk-1",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          ]) as never;
        },
      } as never,
    }),
    started: () => queries,
    resumed: () => resumed,
  };
}

const REFUSING: [string, () => Built, ExternalAgentRunRequest["provider"]][] = [
  ["ClaudeCliDriver", claudeCli, CLAUDE_PROVIDER],
  ["CodexCliDriver", codexCli, CODEX_PROVIDER],
  ["FxCliDriver (persistSession: false)", fxCliStateless, FX_PROVIDER],
];

const ALL: [string, () => Built, ExternalAgentRunRequest["provider"]][] = [
  ...REFUSING.filter(([name]) => !name.startsWith("FxCliDriver")),
  ["FxCliDriver", fxCli, FX_PROVIDER],
  ["CodexSdkDriver", codexSdk, CODEX_PROVIDER],
  ["ClaudeAgentSdkDriver", claudeSdk, CLAUDE_PROVIDER],
];

function permissionsFor(provider: ExternalAgentRunRequest["provider"]) {
  // fx refuses read-only.
  if (provider === FX_PROVIDER) {
    return { mode: "ask", allowNetwork: true } as const;
  }
  return { mode: "read-only", allowNetwork: true } as const;
}

describe("sessions rule", () => {
  test("R1: the Claude Agent SDK driver declares sessions", () => {
    expect(new ClaudeAgentSdkDriver().capabilities().sessions).toBe(true);
  });

  for (const [name, build, provider] of REFUSING) {
    test(`R2: ${name} refuses runtimeSession before any spawn`, async () => {
      const built = build();
      const events = await drain(
        built.driver.run(
          request(provider, {
            permissions: permissionsFor(provider),
            runtimeSession: { id: "x" },
          }),
        ),
      );
      const rest = events.filter((event) => event.type !== "started");
      expect(rest[0]).toMatchObject({
        type: "error",
        code: CODE,
        recoverable: false,
      });
      expect(rest[1]).toMatchObject({ type: "completed", exitCode: 1 });
      expect(rest).toHaveLength(2);
      expect(built.started()).toBe(0);
    });

    test(`R2: ${name} still runs without runtimeSession`, async () => {
      const built = build();
      const events = await drain(
        built.driver.run(
          request(provider, { permissions: permissionsFor(provider) }),
        ),
      );
      expect(events.some((e) => "code" in e && e.code === CODE)).toBe(false);
      expect(built.started()).toBe(1);
    });
  }

  for (const [name, build, provider] of ALL) {
    test(`R3: ${name} follows its sessions capability`, async () => {
      const built = build();
      const declared = built.driver.capabilities?.().sessions === true;
      const events = await drain(
        built.driver.run(
          request(provider, {
            permissions: permissionsFor(provider),
            runtimeSession: { id: "resume-9" },
          }),
        ),
      );
      const refused = events.some((e) => "code" in e && e.code === CODE);
      if (declared) {
        expect(refused).toBe(false);
        expect(built.resumed()).toEqual(["resume-9"]);
      } else {
        expect(refused).toBe(true);
        expect(built.started()).toBe(0);
      }
    });
  }

  test("R3: every Driver class exported from agents is in the list", () => {
    // Abstract bases and placeholders have no runtime to resume.
    const excluded = new Set([
      "PlaceholderExternalAgentDriver",
      "SubprocessJsonlDriver",
    ]);
    const exported = Object.entries(agents)
      .filter(
        ([name, value]) =>
          /Driver$/.test(name) &&
          typeof value === "function" &&
          !excluded.has(name),
      )
      .map(([name]) => name)
      .sort();
    expect(ALL.map(([name]) => name).sort()).toEqual(exported);
  });

  test("R3: the conformance set has both kinds of driver", () => {
    const flags = ALL.map(
      ([, build]) => build().driver.capabilities?.().sessions,
    );
    expect(flags.filter((flag) => flag === true)).toHaveLength(3);
    expect(flags.filter((flag) => flag !== true)).toHaveLength(2);
  });
});
