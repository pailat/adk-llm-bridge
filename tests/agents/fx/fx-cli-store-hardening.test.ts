import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import { fxArtifactSessionStore } from "../../../src/agents/session-store/fx-artifacts.js";
import {
  baseConfig,
  collect,
  errorsOf,
  FX_SUCCESS,
  makeRequest,
  recordingSpawn,
} from "./helpers.js";

const SESSION_ID = "sR9HE8eyKMz1";
const STATE_KEY = "fx_session:fx-agent";

const withSession = (id: string) =>
  `${JSON.stringify({ ...FX_SUCCESS, session_id: id })}\n`;

function request(state: Record<string, unknown> = {}) {
  return makeRequest(FX_PROVIDER, {
    agent: { name: "fx-agent" } as never,
    context: { input: "hi", session: { state } } as never,
  });
}

type Bundle = {
  version: 1;
  directories: string[];
  files: { path: string; base64: string }[];
};

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
const sessionsRoot = (home: string) => join(home, ".fx", "sessions", "v2");
const sessionDir = (home: string, id = SESSION_ID) =>
  join(sessionsRoot(home), id);

function memoryStore(initial?: Bundle) {
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
}

const text = (value: string) => Buffer.from(value).toString("base64");

describe("session store cancellation", () => {
  for (const operation of ["load", "save"] as const) {
    test(`abort during ${operation} ends the run`, async () => {
      const home = makeHome();
      if (operation === "save") {
        mkdirSync(sessionDir(home), { recursive: true });
        writeFileSync(join(sessionDir(home), "log.jsonl"), "session\n");
      }
      const controller = new AbortController();
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const never = () => {
        entered();
        return new Promise<never>(() => {});
      };
      const fake = recordingSpawn([withSession(SESSION_ID)]);
      const store = {
        load: operation === "load" ? never : async () => undefined,
        save: operation === "save" ? never : async () => {},
      };
      const eventsPromise = collect(
        new FxCliDriver(
          baseConfig({
            spawn: fake.spawn,
            env: { PATH: "/usr/bin", HOME: home },
            sessionStore: store,
          }),
        ).run({
          ...request(operation === "load" ? { [STATE_KEY]: SESSION_ID } : {}),
          abortSignal: controller.signal,
        }),
      );
      await waiting;
      controller.abort();
      const events = await Promise.race([
        eventsPromise,
        new Promise<undefined>((resolve) => setTimeout(resolve, 200)),
      ]);
      expect(events).toBeDefined();
      expect(events?.some((event) => event.type === "completed")).toBe(false);
      if (operation === "load") expect(fake.calls).toHaveLength(0);
    });
  }
});

describe("sessionStore: one store per run", () => {
  test("the factory is called once on a turn that restores and saves", async () => {
    const home = makeHome();
    const memory = memoryStore({
      version: 1,
      directories: [],
      files: [{ path: "log.jsonl", base64: text("old\n") }],
    });
    let calls = 0;
    const fake = recordingSpawn([withSession(SESSION_ID)]);
    await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => {
            calls++;
            return memory.store;
          },
        }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    expect(memory.loaded).toEqual([SESSION_ID]);
    expect(memory.saved).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("a factory that throws is a recoverable warning and the run goes on", async () => {
    const home = makeHome();
    const fake = recordingSpawn([withSession(SESSION_ID)]);
    const events = await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => {
            throw new Error("no artifact service");
          },
        }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    expect(fake.calls).toHaveLength(1);
    const errors = errorsOf(events);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).toMatchObject({
        code: "FX_SESSION_STORE_ERROR",
        recoverable: true,
      });
    }
    expect(errors[0]?.message).toContain("no artifact service");
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });

  test("a plain store object (not a factory) is used directly", async () => {
    const home = makeHome();
    const memory = memoryStore({
      version: 1,
      directories: [],
      files: [{ path: "log.jsonl", base64: text("old\n") }],
    });
    const fake = recordingSpawn([withSession(SESSION_ID)]);
    const events = await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: memory.store,
        }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    expect(memory.loaded).toEqual([SESSION_ID]);
    expect(memory.saved.map((entry) => entry.id)).toEqual([SESSION_ID]);
    expect(readFileSync(join(sessionDir(home), "log.jsonl"), "utf8")).toBe(
      "old\n",
    );
    expect(errorsOf(events)).toEqual([]);
  });
});

describe("a restore that fails halfway", () => {
  // "a" is written as a file first, so "a/b" cannot be created under it.
  const broken: Bundle = {
    version: 1,
    directories: [],
    files: [
      { path: "a", base64: text("file") },
      { path: "a/b", base64: text("never") },
    ],
  };

  test("leaves no session directory, and the next run loads again", async () => {
    const home = makeHome();
    const memory = memoryStore(broken);
    const config = (spawn: ReturnType<typeof recordingSpawn>["spawn"]) =>
      baseConfig({
        spawn,
        env: { PATH: "/usr/bin", HOME: home },
        sessionStore: () => memory.store,
      });

    const first = recordingSpawn([withSession(SESSION_ID)]);
    const events = await collect(
      new FxCliDriver(config(first.spawn)).run(
        request({ [STATE_KEY]: SESSION_ID }),
      ),
    );
    expect(errorsOf(events)[0]).toMatchObject({
      code: "FX_SESSION_STORE_ERROR",
      recoverable: true,
    });
    expect(errorsOf(events)[0]?.message).not.toContain("stays only in ~/.fx");
    expect(errorsOf(events)[0]?.message).toContain(
      "The session could not be restored to ~/.fx on this host, so fx may not find it.",
    );
    expect(existsSync(sessionDir(home))).toBe(false);
    // No temporary sibling is left behind either.
    const leftovers = existsSync(sessionsRoot(home))
      ? readdirSync(sessionsRoot(home))
      : [];
    expect(leftovers).toEqual([]);

    const second = recordingSpawn([withSession(SESSION_ID)]);
    await collect(
      new FxCliDriver(config(second.spawn)).run(
        request({ [STATE_KEY]: SESSION_ID }),
      ),
    );
    expect(memory.loaded).toEqual([SESSION_ID, SESSION_ID]);
  });

  test("a good bundle is restored whole", async () => {
    const home = makeHome();
    const memory = memoryStore({
      version: 1,
      directories: ["blobs"],
      files: [
        { path: "log.jsonl", base64: text("ok\n") },
        { path: "blobs/x", base64: text("blob") },
      ],
    });
    const fake = recordingSpawn([withSession(SESSION_ID)]);
    await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: () => memory.store,
        }),
      ).run(request({ [STATE_KEY]: SESSION_ID })),
    );
    expect(readFileSync(join(sessionDir(home), "blobs", "x"), "utf8")).toBe(
      "blob",
    );
    expect(readdirSync(sessionsRoot(home))).toEqual([SESSION_ID]);
  });
});

describe("an unusable session id from fx", () => {
  test("is reported without naming a store when none is configured", async () => {
    const fake = recordingSpawn([withSession("bad id")]);
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
    );
    const [error] = errorsOf(events);
    expect(error).toMatchObject({
      code: "FX_SESSION_STORE_ERROR",
      recoverable: true,
    });
    expect(error?.message).not.toMatch(/store/i);
    expect(error?.message).toContain("plain token");
    expect(error?.message).toContain("length 6");
    expect(error?.message).toContain("first character: letter");
    expect(error?.message).not.toContain("bad id");
    expect(events.some((event) => event.type === "state_delta")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });

  for (const [id, kind] of [
    ["1=secret", "digit"],
    ["-=secret", "-"],
    ["_=secret", "_"],
    ["=secret", "other"],
  ]) {
    test(`describes the first character as ${kind}`, async () => {
      const fake = recordingSpawn([withSession(id)]);
      const events = await collect(
        new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
      );
      const message = errorsOf(events)[0]?.message ?? "";
      expect(message).toContain(`length ${id.length}`);
      expect(message).toContain(`first character: ${kind}`);
      expect(message).not.toContain(id);
    });
  }

  test("is not saved to a configured store", async () => {
    const home = makeHome();
    const memory = memoryStore();
    const fake = recordingSpawn([withSession("bad=id")]);
    const events = await collect(
      new FxCliDriver(
        baseConfig({
          spawn: fake.spawn,
          env: { PATH: "/usr/bin", HOME: home },
          sessionStore: memory.store,
        }),
      ).run(request()),
    );
    expect(memory.saved).toEqual([]);
    expect(errorsOf(events)[0]?.code).toBe("FX_SESSION_STORE_ERROR");
  });
});

describe("fxArtifactSessionStore options", () => {
  test("artifactService adds the app, user and session scope from the context", async () => {
    const seen: Record<string, unknown>[] = [];
    const artifactService = {
      saveArtifact: async (req: Record<string, unknown>) => {
        seen.push({ call: "save", ...req });
        return 0;
      },
      loadArtifact: async (req: Record<string, unknown>) => {
        seen.push({ call: "load", ...req });
        return undefined;
      },
    };
    const store = fxArtifactSessionStore({
      artifactService: artifactService as never,
    })({
      context: {
        session: { appName: "app", userId: "u1", id: "s1" },
      } as never,
    });
    await store.save(SESSION_ID, {
      version: 1,
      directories: [],
      files: [],
    });
    await store.load(SESSION_ID);
    const scope = { appName: "app", userId: "u1", sessionId: "s1" };
    expect(seen[0]).toMatchObject({
      call: "save",
      ...scope,
      filename: `fx-session.v1.${SESSION_ID}.json`,
    });
    expect(seen[1]).toMatchObject({
      call: "load",
      ...scope,
      filename: `fx-session.v1.${SESSION_ID}.json`,
    });
  });

  test("the option wins over context.artifactService", async () => {
    const used: string[] = [];
    const make = (name: string) => ({
      saveArtifact: async () => {
        used.push(name);
        return 0;
      },
      loadArtifact: async () => undefined,
    });
    const store = fxArtifactSessionStore({
      artifactService: make("option") as never,
    })({
      context: {
        artifactService: make("context"),
        session: { appName: "a", userId: "u", id: "s" },
      } as never,
    });
    await store.save(SESSION_ID, { version: 1, directories: [], files: [] });
    expect(used).toEqual(["option"]);
  });

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    test(`maxBytes ${bad} is refused when the factory is built`, () => {
      expect(() => fxArtifactSessionStore({ maxBytes: bad })).toThrow(
        /maxBytes/,
      );
    });
  }
});
