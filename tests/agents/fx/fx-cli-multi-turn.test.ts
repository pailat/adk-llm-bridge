import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FxCliDriver,
  fxSessionStateKey,
} from "../../../src/agents/driver/fx-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  collect,
  errorsOf,
  FX_SUCCESS,
  forbiddenSpawn,
  makeRequest,
  recordingSpawn,
} from "./helpers.js";

const SESSION_ID = "sR9HE8eyKMz1";
const STATE_KEY = "fx_session:fx-agent";

/** A successful fx result that names the session it ran in. */
const withSession = (id = SESSION_ID, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ ...FX_SUCCESS, session_id: id, ...extra })}\n`;

/** A request of the agent `fx-agent`, with ADK session state as given. */
function request(
  state: Record<string, unknown> = {},
  overrides: Parameters<typeof makeRequest>[1] = {},
) {
  return makeRequest(FX_PROVIDER, {
    agent: { name: "fx-agent" } as never,
    context: { input: "hi", session: { state } } as never,
    ...overrides,
  });
}

const stateDeltas = (events: ExternalAgentEvent[]) =>
  events.flatMap((event) =>
    event.type === "state_delta" ? [event.stateDelta] : [],
  );

describe("first turn", () => {
  test("runs without --no-save and without --resume-id", async () => {
    const fake = recordingSpawn([withSession()]);
    await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
    );
    expect(fake.calls).toHaveLength(1);
    const args = fake.calls[0]?.args ?? [];
    expect(args.slice(0, 3)).toEqual(["ask", "--json", "--no-color"]);
    expect(args).not.toContain("--no-save");
    expect(args).not.toContain("--resume-id");
  });

  test("stores the fx session id in ADK session state", async () => {
    const fake = recordingSpawn([withSession()]);
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
    );
    expect(stateDeltas(events)).toEqual([{ [STATE_KEY]: SESSION_ID }]);
    expect(fxSessionStateKey("fx-agent")).toBe(STATE_KEY);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "state_delta",
      "completed",
    ]);
  });

  test("writes no state when fx reports no session id", async () => {
    const fake = recordingSpawn([withSession("")]);
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
    );
    expect(stateDeltas(events)).toEqual([]);
  });

  test("writes no state without an agent name", async () => {
    const fake = recordingSpawn([withSession()]);
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        request({}, { agent: undefined }),
      ),
    );
    expect(stateDeltas(events)).toEqual([]);
  });
});

describe("second turn", () => {
  test("resumes the stored id with --resume-id and no --no-save", async () => {
    const fake = recordingSpawn([withSession()]);
    await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        request({ [STATE_KEY]: SESSION_ID }),
      ),
    );
    const args = fake.calls[0]?.args ?? [];
    const at = args.indexOf("--resume-id");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe(SESSION_ID);
    expect(args).not.toContain("--no-save");
  });

  for (const id of ["-x", "--yolo"]) {
    test(`stores and safely resumes ${id}`, async () => {
      const fake = recordingSpawn([withSession(id), withSession(id)]);
      const driver = new FxCliDriver(baseConfig({ spawn: fake.spawn }));
      const first = await collect(driver.run(request()));
      expect(stateDeltas(first)).toEqual([{ [STATE_KEY]: id }]);
      await collect(driver.run(request(stateDeltas(first)[0])));
      expect(fake.calls[1]?.args).toEqual([
        "ask",
        "--json",
        "--no-color",
        "--resume-id",
        id,
        "--model",
        "anthropic/claude-haiku-5.5",
      ]);
    });
  }

  test("describes a rejected resume id without exposing it", async () => {
    const id = "bad secret";
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: forbiddenSpawn().spawn })).run(
        request({ [STATE_KEY]: id }),
      ),
    );
    const message = errorsOf(events)[0]?.message ?? "";
    expect(message).toContain("length 10");
    expect(message).toContain("first character: letter");
    expect(message).not.toContain(id);
  });

  test("does not write the id again when it is already stored", async () => {
    const fake = recordingSpawn([withSession()]);
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        request({ [STATE_KEY]: SESSION_ID }),
      ),
    );
    expect(stateDeltas(events)).toEqual([]);
  });

  test("another agent's state key is not resumed", async () => {
    const fake = recordingSpawn([withSession()]);
    await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        request({ "fx_session:other": "someoneElse1" }),
      ),
    );
    expect(fake.calls[0]?.args).not.toContain("--resume-id");
  });

  test("order: resumeSessionId, then runtimeSession.id, then state", async () => {
    const make = (config: Parameters<typeof baseConfig>[0], req: object) => {
      const fake = recordingSpawn([withSession()]);
      return collect(
        new FxCliDriver(baseConfig({ spawn: fake.spawn, ...config })).run(
          req as never,
        ),
      ).then(() => fake.calls[0]?.args ?? []);
    };
    const state = { [STATE_KEY]: "fromState1" };
    const fromRuntime = await make(
      {},
      request(state, { runtimeSession: { id: "fromRuntime1" } }),
    );
    expect(fromRuntime[fromRuntime.indexOf("--resume-id") + 1]).toBe(
      "fromRuntime1",
    );
    const fromConfig = await make(
      { resumeSessionId: "fromConfig1" },
      request(state, { runtimeSession: { id: "fromRuntime1" } }),
    );
    expect(fromConfig[fromConfig.indexOf("--resume-id") + 1]).toBe(
      "fromConfig1",
    );
  });

  for (const id of ["-", "--"]) {
    test(`refuses bare hyphen id ${id} before spawning`, async () => {
      const fake = forbiddenSpawn();
      const events = await collect(
        new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
          request({ [STATE_KEY]: id }),
        ),
      );
      expect(errorsOf(events)[0]?.code).toBe(
        "EXTERNAL_AGENT_OPTION_UNSUPPORTED",
      );
      expect(errorsOf(events)[0]?.message).toContain(
        `length ${id.length}, first character: -`,
      );
      expect(fake.state.called).toBe(0);
      expect(
        () => new FxCliDriver(baseConfig({ resumeSessionId: id })),
      ).toThrow();
    });
  }

  test("a stored id that is not a plain token is refused before any spawn", async () => {
    for (const bad of ["a b", "a=b", "../x", "x".repeat(129)]) {
      const fake = forbiddenSpawn();
      const events = await collect(
        new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
          request({ [STATE_KEY]: bad }),
        ),
      );
      expect(errorsOf(events)[0]?.code).toBe(
        "EXTERNAL_AGENT_OPTION_UNSUPPORTED",
      );
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
      expect(fake.state.called).toBe(0);
    }
  });
});

describe("stateless opt-out", () => {
  test("persistSession: false keeps --no-save and ignores a stored id", async () => {
    const fake = recordingSpawn([withSession()]);
    const events = await collect(
      new FxCliDriver(
        baseConfig({ spawn: fake.spawn, persistSession: false }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    const args = fake.calls[0]?.args ?? [];
    expect(args).toContain("--no-save");
    expect(args).not.toContain("--resume-id");
    expect(stateDeltas(events)).toEqual([]);
  });

  test("capabilities report sessions only when sessions persist", () => {
    expect(new FxCliDriver(baseConfig()).capabilities()).toEqual({
      streaming: false,
      permissions: true,
      sessions: true,
    });
    expect(
      new FxCliDriver(baseConfig({ persistSession: false })).capabilities(),
    ).toEqual({ streaming: false, permissions: true });
  });

  test("persistSession: false refuses a runtimeSession like the CLI drivers", async () => {
    const fake = forbiddenSpawn();
    const events = await collect(
      new FxCliDriver(
        baseConfig({ spawn: fake.spawn, persistSession: false }),
      ).run(request({}, { runtimeSession: { id: "x" } })),
    );
    expect(errorsOf(events)[0]?.code).toBe(
      "EXTERNAL_AGENT_SESSIONS_UNSUPPORTED",
    );
    expect(fake.state.called).toBe(0);
  });

  test("persistSession must be a boolean", () => {
    expect(
      () => new FxCliDriver(baseConfig({ persistSession: "no" as never })),
    ).toThrow();
  });
});

describe("driver-owned flags", () => {
  const owned = [
    ["--resume-id", SESSION_ID],
    ["--resume", "last"],
    ["--no-save"],
    ["--resume-last"],
  ];
  for (const args of owned) {
    test(`args ${args.join(" ")} cannot be set, even with every opt-in`, () => {
      let code: string | undefined;
      try {
        new FxCliDriver(baseConfig({ args, allowPolicyOverrideArgs: true }));
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("EXTERNAL_AGENT_OPTION_UNSUPPORTED");
    });
  }
});

describe("session options", () => {
  test("resumeSessionId must be a plain token", () => {
    expect(
      () => new FxCliDriver(baseConfig({ resumeSessionId: "bad id" })),
    ).toThrow();
    expect(
      () => new FxCliDriver(baseConfig({ resumeSessionId: "" })),
    ).toThrow();
  });

  test("resumeSessionId and sessionStore need persistSession", () => {
    for (const extra of [
      { resumeSessionId: SESSION_ID },
      {
        sessionStore: () => ({
          save: async () => {},
          load: async () => undefined,
        }),
      },
    ]) {
      expect(
        () =>
          new FxCliDriver(
            baseConfig({ persistSession: false, ...extra } as never),
          ),
      ).toThrow();
    }
  });

  test("sessionStoreFlush and sessionStoreLoadTimeoutMs stay refused", () => {
    for (const option of ["sessionStoreFlush", "sessionStoreLoadTimeoutMs"]) {
      let error: { code?: string; message: string } | undefined;
      try {
        new FxCliDriver(baseConfig({ [option]: 1 } as never));
      } catch (caught) {
        error = caught as { code?: string; message: string };
      }
      expect(error?.code).toBe("EXTERNAL_AGENT_OPTION_UNSUPPORTED");
      expect(error?.message).toContain(option);
    }
  });
});

describe("lost session", () => {
  const lost = `${JSON.stringify({
    output: "",
    final_output: "",
    exit_code: 1,
    model: "",
    resolved_provider: null,
    session_id: "",
    steps: 0,
    tool_calls: [],
    usage: { input_tokens: null, output_tokens: null },
    error: "SessionNotFound",
  })}\n`;

  test("is an error, not a silent new session", async () => {
    const fake = recordingSpawn([lost], 1);
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        request({ [STATE_KEY]: "gone00000001" }),
      ),
    );
    const [error] = errorsOf(events);
    expect(error).toMatchObject({
      code: "FX_CLI_SESSION_NOT_FOUND",
      recoverable: false,
    });
    expect(error?.message).toContain("gone00000001");
    expect(fake.calls).toHaveLength(1);
    expect(stateDeltas(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("the code is the same without an id in state (fx names the failure)", async () => {
    const fake = recordingSpawn([lost], 1);
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
    );
    expect(errorsOf(events)[0]?.code).toBe("FX_CLI_SESSION_NOT_FOUND");
  });
});

describe("session directory in a session store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const makeHome = () => {
    const home = mkdtempSync(join(tmpdir(), "fx-home-"));
    dirs.push(home);
    return home;
  };
  const sessionDir = (home: string, id = SESSION_ID) =>
    join(home, ".fx", "sessions", "v2", id);

  type Bundle = {
    version: 1;
    directories: string[];
    files: { path: string; base64: string }[];
  };
  const memoryStore = (initial?: Bundle) => {
    const saved: { id: string; bundle: Bundle }[] = [];
    const loaded: string[] = [];
    return {
      saved,
      loaded,
      store: {
        save: async (id: string, bundle: Bundle) => {
          saved.push({ id, bundle });
        },
        load: async (id: string) => {
          loaded.push(id);
          return initial;
        },
      },
    };
  };

  test("saves the whole directory, blobs included, after a successful turn", async () => {
    const home = makeHome();
    const dir = sessionDir(home);
    mkdirSync(join(dir, "blobs"), { recursive: true });
    writeFileSync(join(dir, "log.jsonl"), '{"turn":1}\n');
    writeFileSync(join(dir, "blobs", "abc"), Buffer.from([0, 1, 2, 255]));
    const memory = memoryStore();
    const fake = recordingSpawn([withSession()]);
    await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => memory.store,
        }),
      ).run(request()),
    );
    expect(memory.saved).toHaveLength(1);
    const { id, bundle } = memory.saved[0] as (typeof memory.saved)[number];
    expect(id).toBe(SESSION_ID);
    expect(bundle.directories).toContain("blobs");
    const byPath = new Map(bundle.files.map((f) => [f.path, f.base64]));
    expect(byPath.get("log.jsonl")).toBe(
      Buffer.from('{"turn":1}\n').toString("base64"),
    );
    expect(byPath.get("blobs/abc")).toBe(
      Buffer.from([0, 1, 2, 255]).toString("base64"),
    );
  });

  test("restores a missing directory before --resume-id runs", async () => {
    const home = makeHome();
    const dir = sessionDir(home);
    const bundle: Bundle = {
      version: 1,
      directories: ["blobs"],
      files: [
        { path: "log.jsonl", base64: Buffer.from("old\n").toString("base64") },
        { path: "blobs/abc", base64: Buffer.from([9, 8]).toString("base64") },
      ],
    };
    const memory = memoryStore(bundle);
    let seen: { log?: string; blob?: number[] } = {};
    const spawn = (_c: string, _a: readonly string[]) => {
      seen = {
        log: readFileSync(join(dir, "log.jsonl"), "utf8"),
        blob: [...readFileSync(join(dir, "blobs", "abc"))],
      };
      return {
        stdout: [withSession()],
        stderr: [],
        exited: Promise.resolve(0),
      };
    };
    const events = await collect(
      new FxCliDriver(
        baseConfig({
          spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => memory.store,
        }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    expect(memory.loaded).toEqual([SESSION_ID]);
    expect(seen).toEqual({ log: "old\n", blob: [9, 8] });
    expect(errorsOf(events)).toEqual([]);
  });

  test("does not load or overwrite a directory that is already on disk", async () => {
    const home = makeHome();
    const dir = sessionDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "log.jsonl"), "local\n");
    const memory = memoryStore({
      version: 1,
      directories: [],
      files: [
        {
          path: "log.jsonl",
          base64: Buffer.from("remote\n").toString("base64"),
        },
      ],
    });
    const fake = recordingSpawn([withSession()]);
    await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => memory.store,
        }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    expect(memory.loaded).toEqual([]);
    expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toBe("local\n");
  });

  test("a bundle path that leaves the directory is refused and nothing is written", async () => {
    const home = makeHome();
    const memory = memoryStore({
      version: 1,
      directories: [],
      files: [
        { path: "../escaped", base64: Buffer.from("x").toString("base64") },
      ],
    });
    const fake = recordingSpawn([withSession()]);
    const events = await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => memory.store,
        }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    expect(existsSync(join(sessionDir(home), "..", "escaped"))).toBe(false);
    const [error] = errorsOf(events);
    expect(error).toMatchObject({
      code: "FX_SESSION_STORE_ERROR",
      recoverable: true,
    });
  });

  test("a store that fails to save is reported and the run still completes", async () => {
    const home = makeHome();
    mkdirSync(sessionDir(home), { recursive: true });
    const fake = recordingSpawn([withSession()]);
    const events = await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => ({
            save: async () => {
              throw new Error("disk full");
            },
            load: async () => undefined,
          }),
        }),
      ).run(request()),
    );
    expect(errorsOf(events)[0]).toMatchObject({
      code: "FX_SESSION_STORE_ERROR",
      recoverable: true,
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });
});
