import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionStore as SdkSessionStore,
  SessionStoreEntry as SdkSessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import type {
  BaseArtifactService,
  InvocationContext,
  SessionArtifactService,
} from "@google/adk";
import {
  FileArtifactService,
  InMemoryArtifactService,
  ScopedArtifactService,
} from "@google/adk";
import {
  AdkArtifactSessionStore,
  AdkArtifactSessionStoreError,
  adkArtifactSessionStore,
} from "../../../src/agents/session-store/adk-artifacts/index.js";
import { SqliteSessionStore } from "../../../src/agents/session-store/sqlite/index.js";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "../../../src/agents/session-store/types.js";

const SCOPE = { appName: "app", userId: "user", sessionId: "adk-s1" };
const key: SessionKey = { projectKey: "/work/proj", sessionId: "s1" };

const dirs: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "adk-artifact-store-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scoped(
  base: BaseArtifactService,
  scope = SCOPE,
): SessionArtifactService {
  return new ScopedArtifactService(
    base,
    scope.appName,
    scope.userId,
    scope.sessionId,
  );
}

function makeStore(
  base: BaseArtifactService = new InMemoryArtifactService(),
  options: { maxVersionBytes?: number } = {},
): AdkArtifactSessionStore {
  return new AdkArtifactSessionStore({
    artifactService: scoped(base),
    ...options,
  });
}

type Calls = { save: unknown[]; load: unknown[]; other: string[] };

/** Wraps a session service and records every call. */
function spy(inner: SessionArtifactService): {
  service: SessionArtifactService;
  calls: Calls;
} {
  const calls: Calls = { save: [], load: [], other: [] };
  const service: SessionArtifactService = {
    saveArtifact: (request) => {
      calls.save.push(request);
      return inner.saveArtifact(request);
    },
    loadArtifact: (request) => {
      calls.load.push(request);
      return inner.loadArtifact(request);
    },
    listArtifactKeys: () => {
      calls.other.push("listArtifactKeys");
      return inner.listArtifactKeys();
    },
    deleteArtifact: (filename) => {
      calls.other.push("deleteArtifact");
      return inner.deleteArtifact(filename);
    },
    listVersions: (filename) => {
      calls.other.push("listVersions");
      return inner.listVersions(filename);
    },
    listArtifactVersions: (filename) => {
      calls.other.push("listArtifactVersions");
      return inner.listArtifactVersions(filename);
    },
    getArtifactVersion: (request) => inner.getArtifactVersion(request),
  };
  return { service, calls };
}

/**
 * A service that reproduces the GCS and File version race: the version
 * number is chosen from a listing, and the write lands after a delay, so two
 * saves of one filename that overlap pick the same version and the last
 * write wins.
 */
class RacyArtifactService implements BaseArtifactService {
  readonly versions = new Map<
    string,
    Array<{ part: unknown; metadata?: Record<string, unknown> } | undefined>
  >();
  maxInFlight = 0;
  #inFlight = 0;

  async saveArtifact(request: {
    appName: string;
    userId: string;
    sessionId: string;
    filename: string;
    artifact: unknown;
    customMetadata?: Record<string, unknown>;
  }): Promise<number> {
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    const path = `${request.sessionId}/${request.filename}`;
    const next = (this.versions.get(path)?.length ?? 0) as number;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const list = this.versions.get(path) ?? [];
    list[next] = { part: request.artifact, metadata: request.customMetadata };
    this.versions.set(path, list);
    this.#inFlight -= 1;
    return next;
  }
  async loadArtifact(request: {
    sessionId: string;
    filename: string;
    version?: number;
  }) {
    const list = this.versions.get(`${request.sessionId}/${request.filename}`);
    if (!list) return undefined;
    return list[request.version ?? list.length - 1]?.part as never;
  }
  async listArtifactKeys(request: { sessionId: string }) {
    return [...this.versions.keys()]
      .filter((path) => path.startsWith(`${request.sessionId}/`))
      .map((path) => path.slice(request.sessionId.length + 1))
      .sort();
  }
  async deleteArtifact(request: { sessionId: string; filename: string }) {
    this.versions.delete(`${request.sessionId}/${request.filename}`);
  }
  async listVersions(request: { sessionId: string; filename: string }) {
    const list = this.versions.get(`${request.sessionId}/${request.filename}`);
    return list ? list.map((_, index) => index) : [];
  }
  async listArtifactVersions(request: { sessionId: string; filename: string }) {
    const list =
      this.versions.get(`${request.sessionId}/${request.filename}`) ?? [];
    return list.map((item, index) => ({
      version: index,
      customMetadata: item?.metadata,
    }));
  }
  async getArtifactVersion(request: {
    sessionId: string;
    filename: string;
    version?: number;
  }) {
    const all = await this.listArtifactVersions(request);
    return all[request.version ?? all.length - 1];
  }
}

function userEntry(n: number, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: `u${n}`,
    message: { role: "user", content: `message ${n}` },
    ...extra,
  };
}

async function keysOf(service: BaseArtifactService): Promise<string[]> {
  return service.listArtifactKeys(SCOPE);
}

describe("A1 append and load", () => {
  test("load returns the appended entries deep-equal and in order across batches; an unknown key gives null", async () => {
    const store = makeStore();
    const first = [
      userEntry(1),
      { type: "assistant", uuid: "a1", n: [1, null, true] },
    ];
    const second = [
      { type: "custom-title", title: "T" },
      userEntry(2, { nested: { deep: ["x", { y: 1 }] } }),
    ];
    expect(await store.load(key)).toBeNull();
    await store.append(key, first);
    await store.append(key, second);
    expect(await store.load(key)).toEqual([...first, ...second]);
    expect(await store.load({ ...key, sessionId: "other" })).toBeNull();
    expect(
      await store.load({ ...key, subpath: "subagents/agent-1" }),
    ).toBeNull();
  });

  test("a subagent transcript is separate from the main one", async () => {
    const store = makeStore();
    const sub = { ...key, subpath: "subagents/agent-1" };
    await store.append(key, [userEntry(1)]);
    await store.append(sub, [userEntry(2)]);
    expect(await store.load(key)).toEqual([userEntry(1)]);
    expect(await store.load(sub)).toEqual([userEntry(2)]);
  });

  test("works on the real FileArtifactService, with unicode in the entries and the project key", async () => {
    const root = tempDir();
    const base = new FileArtifactService(root);
    const store = makeStore(base);
    const unicodeKey = { projectKey: "/tmp/日本語 dir:x", sessionId: "s1" };
    const entries = [
      userEntry(1, { text: "héllo 🌍\nline two" }),
      userEntry(2),
    ];
    await store.append(unicodeKey, entries);
    await store.append(unicodeKey, [userEntry(3)]);
    expect(await store.load(unicodeKey)).toEqual([...entries, userEntry(3)]);
    expect(await store.load(key)).toBeNull();
  });

  test("an empty batch writes nothing", async () => {
    const { service, calls } = spy(scoped(new InMemoryArtifactService()));
    const store = new AdkArtifactSessionStore({ artifactService: service });
    await store.append(key, []);
    expect(calls.save).toHaveLength(0);
    expect(await store.load(key)).toBeNull();
  });
});

describe("evidence: nested artifact filenames on the File service", () => {
  test("a filename with slashes lists and versions like a flat one in @google/adk", async () => {
    const base = new FileArtifactService(tempDir());
    await base.saveArtifact({
      ...SCOPE,
      filename: "a",
      artifact: { text: "1" },
    });
    await base.saveArtifact({
      ...SCOPE,
      filename: "a/subagents/x.jsonl",
      artifact: { text: "2" },
    });
    expect(await base.listArtifactKeys(SCOPE)).toEqual([
      "a",
      "a/subagents/x.jsonl",
    ]);
    expect(
      await base.listVersions({ ...SCOPE, filename: "a/subagents/x.jsonl" }),
    ).toEqual([0]);
  });
});

describe("A2 one version per append, no read on write", () => {
  test("each append is exactly one saveArtifact holding only that batch, and nothing is loaded or listed", async () => {
    const { service, calls } = spy(scoped(new InMemoryArtifactService()));
    const store = new AdkArtifactSessionStore({ artifactService: service });
    const batch1 = [userEntry(1), userEntry(2)];
    const batch2 = [userEntry(3)];
    await store.append(key, batch1);
    await store.append(key, batch2);
    expect(calls.save).toHaveLength(2);
    expect(calls.load).toHaveLength(0);
    expect(calls.other).toEqual([]);
    const texts = (calls.save as Array<{ artifact: { text: string } }>).map(
      (request) => request.artifact.text,
    );
    expect(texts[0]).toBe(batch1.map((e) => JSON.stringify(e)).join("\n"));
    expect(texts[1]).toBe(batch2.map((e) => JSON.stringify(e)).join("\n"));
    const filenames = new Set(
      (calls.save as Array<{ filename: string }>).map((r) => r.filename),
    );
    expect(filenames.size).toBe(1);
    expect(await service.listVersions([...filenames][0] as string)).toEqual([
      0, 1,
    ]);
  });

  test("each version carries format metadata the load path and listSessions read", async () => {
    const { service, calls } = spy(scoped(new InMemoryArtifactService()));
    const store = new AdkArtifactSessionStore({ artifactService: service });
    await store.append(key, [userEntry(1), userEntry(2)]);
    const request = calls.save[0] as {
      customMetadata: Record<string, unknown>;
    };
    expect(request.customMetadata).toMatchObject({
      format: "claude-session.v1",
      projectKey: key.projectKey,
      sessionId: key.sessionId,
      entries: 2,
    });
    expect(typeof request.customMetadata.mtime).toBe("number");
  });
});

describe("A3 uuid idempotency", () => {
  test("a replayed batch leaves one row per uuid, in the first position, with the last value", async () => {
    const store = makeStore();
    await store.append(key, [userEntry(1), userEntry(2), userEntry(3)]);
    await store.append(key, [userEntry(2, { edited: true }), userEntry(4)]);
    await store.append(key, [userEntry(1, { edited: "again" })]);
    expect(await store.load(key)).toEqual([
      userEntry(1, { edited: "again" }),
      userEntry(2, { edited: true }),
      userEntry(3),
      userEntry(4),
    ]);
  });

  test("the same uuid inside one batch collapses to one row", async () => {
    const store = makeStore();
    await store.append(key, [
      userEntry(1),
      userEntry(2),
      userEntry(1, { v: 2 }),
    ]);
    expect(await store.load(key)).toEqual([
      userEntry(1, { v: 2 }),
      userEntry(2),
    ]);
  });

  test("entries with no uuid, an empty uuid, or a non-string uuid are always kept", async () => {
    const store = makeStore();
    const rows = [
      { type: "custom-title", title: "a" },
      { type: "custom-title", title: "a" },
      { type: "x", uuid: "" },
      { type: "x", uuid: "" },
      { type: "x", uuid: 7 },
      { type: "x", uuid: 7 },
    ] as unknown as SessionStoreEntry[];
    await store.append(key, rows);
    await store.append(key, rows);
    expect(await store.load(key)).toEqual([...rows, ...rows]);
  });

  test("the same uuid under another key is a different row", async () => {
    const store = makeStore();
    await store.append(key, [userEntry(1)]);
    await store.append({ ...key, sessionId: "s2" }, [userEntry(1, { v: 2 })]);
    await store.append({ ...key, subpath: "subagents/a" }, [
      userEntry(1, { v: 3 }),
    ]);
    expect(await store.load(key)).toEqual([userEntry(1)]);
    expect(await store.load({ ...key, sessionId: "s2" })).toEqual([
      userEntry(1, { v: 2 }),
    ]);
    expect(await store.load({ ...key, subpath: "subagents/a" })).toEqual([
      userEntry(1, { v: 3 }),
    ]);
  });
});

describe("A4 a late duplicate batch", () => {
  test("the same batch saved twice (an SDK timeout whose call still lands) adds no rows", async () => {
    const base = new InMemoryArtifactService();
    const store = makeStore(base);
    const batch = [
      userEntry(1),
      userEntry(2),
      { type: "custom-title", title: "t" },
    ];
    await store.append(key, batch);
    await store.append(key, [userEntry(3)]);
    // The first batch lands a second time, after the following one.
    await store.append(key, batch);
    const loaded = await store.load(key);
    expect(loaded?.filter((e) => e.uuid === "u1")).toHaveLength(1);
    expect(loaded?.filter((e) => e.uuid === "u2")).toHaveLength(1);
    expect(loaded?.map((e) => e.uuid)).toEqual([
      "u1",
      "u2",
      undefined,
      "u3",
      undefined,
    ]);
    // Duplicates cost an artifact version, never a row.
    const [filename] = await keysOf(base);
    expect(
      await base.listVersions({ ...SCOPE, filename: filename as string }),
    ).toHaveLength(3);
  });
});

describe("A5 maxVersionBytes", () => {
  test("a batch over the limit is split into consecutive versions and load keeps the order", async () => {
    const base = new InMemoryArtifactService();
    const store = makeStore(base, { maxVersionBytes: 200 });
    const entries = Array.from({ length: 12 }, (_, i) =>
      userEntry(i, { pad: "x".repeat(40) }),
    );
    await store.append(key, entries);
    const [filename] = await keysOf(base);
    const versions = await base.listVersions({
      ...SCOPE,
      filename: filename as string,
    });
    expect(versions.length).toBeGreaterThan(1);
    for (const version of versions) {
      const part = await base.loadArtifact({
        ...SCOPE,
        filename: filename as string,
        version,
      });
      expect(Buffer.byteLength(part?.text ?? "", "utf8")).toBeLessThanOrEqual(
        200,
      );
    }
    expect(await store.load(key)).toEqual(entries);
  });

  test("a batch that fits is one version; the limit counts UTF-8 bytes", async () => {
    const base = new InMemoryArtifactService();
    const small = makeStore(base, { maxVersionBytes: 10_000 });
    await small.append(key, [userEntry(1), userEntry(2)]);
    const [filename] = await keysOf(base);
    expect(
      await base.listVersions({ ...SCOPE, filename: filename as string }),
    ).toEqual([0]);

    const base2 = new InMemoryArtifactService();
    const wide = makeStore(base2, { maxVersionBytes: 100 });
    // 30 characters, 90 UTF-8 bytes each plus the JSON around them.
    await wide.append(key, [
      { type: "t", uuid: "a", s: "日".repeat(30) },
      { type: "t", uuid: "b", s: "日".repeat(30) },
    ]);
    const [filename2] = await keysOf(base2);
    expect(
      await base2.listVersions({ ...SCOPE, filename: filename2 as string }),
    ).toEqual([0, 1]);
  });

  test("a single entry over the limit is written alone, not refused", async () => {
    const base = new InMemoryArtifactService();
    const store = makeStore(base, { maxVersionBytes: 50 });
    const big = userEntry(1, { pad: "y".repeat(500) });
    await store.append(key, [userEntry(0), big, userEntry(2)]);
    const [filename] = await keysOf(base);
    const versions = await base.listVersions({
      ...SCOPE,
      filename: filename as string,
    });
    expect(versions).toHaveLength(3);
    const bigPart = await base.loadArtifact({
      ...SCOPE,
      filename: filename as string,
      version: 1,
    });
    expect(bigPart?.text).toBe(JSON.stringify(big));
    expect(await store.load(key)).toEqual([userEntry(0), big, userEntry(2)]);
  });

  test("a bad maxVersionBytes throws SESSION_STORE_INVALID_OPTION from the constructor and from the factory call", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "10" as never,
    ]) {
      expect(
        () =>
          new AdkArtifactSessionStore({
            artifactService: scoped(new InMemoryArtifactService()),
            maxVersionBytes: bad,
          }),
      ).toThrow(
        expect.objectContaining({
          name: "AdkArtifactSessionStoreError",
          code: "SESSION_STORE_INVALID_OPTION",
        }),
      );
      expect(() => adkArtifactSessionStore({ maxVersionBytes: bad })).toThrow(
        expect.objectContaining({ code: "SESSION_STORE_INVALID_OPTION" }),
      );
    }
    expect(() => adkArtifactSessionStore({ maxVersionBytes: 1 })).not.toThrow();
  });
});

describe("A6 filenames", () => {
  test("no slash, never user:, the claude-session.v1. scheme, for hostile project keys and ids", async () => {
    const base = new InMemoryArtifactService();
    const store = makeStore(base);
    const keys: SessionKey[] = [
      { projectKey: "/a/b/c", sessionId: "s1" },
      { projectKey: "C:\\Users\\x y", sessionId: "s1" },
      { projectKey: "user:admin", sessionId: "user:s" },
      {
        projectKey: "a b:c/d",
        sessionId: "../../etc/passwd",
        subpath: "subagents/agent-1",
      },
      {
        projectKey: "日本語",
        sessionId: "s.with.dots",
        subpath: "user:x/日本",
      },
      { projectKey: "p", sessionId: "x".repeat(300) },
    ];
    for (const k of keys) await store.append(k, [userEntry(1)]);
    const names = await keysOf(base);
    expect(names).toHaveLength(keys.length);
    for (const name of names) {
      expect(name).not.toContain("/");
      expect(name.startsWith("user:")).toBe(false);
      expect(name).toMatch(
        /^claude-session\.v1\.[0-9a-f]{32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.jsonl$/,
      );
    }
    for (const k of keys) expect(await store.load(k)).toEqual([userEntry(1)]);
  });

  test("a plain session id stays readable in the filename; a hostile one is hashed", async () => {
    const base = new InMemoryArtifactService();
    const store = makeStore(base);
    await store.append(
      { projectKey: "p", sessionId: "11111111-2222-4333-8444-555555555555" },
      [userEntry(1)],
    );
    await store.append({ projectKey: "p", sessionId: "a/b" }, [userEntry(1)]);
    const names = await keysOf(base);
    expect(
      names.some((n) =>
        n.includes(".11111111-2222-4333-8444-555555555555.main."),
      ),
    ).toBe(true);
    expect(names.some((n) => /\.h[0-9a-f]{32}\.main\./.test(n))).toBe(true);
  });

  test("two project keys never share an artifact", async () => {
    const base = new InMemoryArtifactService();
    const store = makeStore(base);
    await store.append({ projectKey: "/a", sessionId: "s" }, [userEntry(1)]);
    await store.append({ projectKey: "/b", sessionId: "s" }, [userEntry(2)]);
    expect(await keysOf(base)).toHaveLength(2);
  });

  test("subpaths with slashes and unicode round-trip through listSubkeys", async () => {
    const store = makeStore();
    const subpaths = ["subagents/agent-1", "subagents/日本/agent-2", "a b/c:d"];
    for (const subpath of subpaths)
      await store.append({ ...key, subpath }, [userEntry(1)]);
    const listed = await store.listSubkeys({
      projectKey: key.projectKey,
      sessionId: key.sessionId,
    });
    expect([...listed].sort()).toEqual([...subpaths].sort());
  });
});

describe("A7 listSessions, listSubkeys, delete", () => {
  test("listSessions lists main transcripts of one project with mtime from metadata", async () => {
    const store = makeStore();
    const before = Date.now();
    await store.append({ projectKey: "/p", sessionId: "s1" }, [userEntry(1)]);
    await store.append({ projectKey: "/p", sessionId: "a/b" }, [userEntry(1)]);
    await store.append(
      { projectKey: "/p", sessionId: "s1", subpath: "subagents/x" },
      [userEntry(2)],
    );
    await store.append({ projectKey: "/other", sessionId: "s9" }, [
      userEntry(1),
    ]);
    const after = Date.now();
    const listed = await store.listSessions("/p");
    expect(listed.map((s) => s.sessionId).sort()).toEqual(["a/b", "s1"]);
    for (const item of listed) {
      expect(item.mtime).toBeGreaterThanOrEqual(before);
      expect(item.mtime).toBeLessThanOrEqual(after);
    }
    expect(await store.listSessions("/nothing")).toEqual([]);
  });

  test("listSessions mtime is the time of the latest append", async () => {
    const store = makeStore();
    await store.append(key, [userEntry(1)]);
    const first = (await store.listSessions(key.projectKey))[0]
      ?.mtime as number;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await store.append(key, [userEntry(2)]);
    const second = (await store.listSessions(key.projectKey))[0]
      ?.mtime as number;
    expect(second).toBeGreaterThan(first);
  });

  test("listSubkeys lists the subagents of one session only", async () => {
    const store = makeStore();
    await store.append(key, [userEntry(1)]);
    await store.append({ ...key, subpath: "subagents/a" }, [userEntry(2)]);
    await store.append({ ...key, subpath: "subagents/b" }, [userEntry(2)]);
    await store.append({ ...key, sessionId: "s2", subpath: "subagents/c" }, [
      userEntry(2),
    ]);
    expect((await store.listSubkeys(key)).sort()).toEqual([
      "subagents/a",
      "subagents/b",
    ]);
    expect(await store.listSubkeys({ ...key, sessionId: "none" })).toEqual([]);
  });

  test("delete of a subagent removes only it; delete of main removes the subagents too and leaves other sessions alone", async () => {
    const base = new InMemoryArtifactService();
    const store = makeStore(base);
    const subA = { ...key, subpath: "subagents/a" };
    const subB = { ...key, subpath: "subagents/b" };
    const other = { ...key, sessionId: "s2" };
    const otherProject = { projectKey: "/elsewhere", sessionId: "s1" };
    await store.append(key, [userEntry(1)]);
    await store.append(subA, [userEntry(2)]);
    await store.append(subB, [userEntry(3)]);
    await store.append(other, [userEntry(4)]);
    await store.append({ ...other, subpath: "subagents/a" }, [userEntry(5)]);
    await store.append(otherProject, [userEntry(6)]);

    await store.delete(subA);
    expect(await store.load(subA)).toBeNull();
    expect(await store.load(subB)).toEqual([userEntry(3)]);
    expect(await store.load(key)).toEqual([userEntry(1)]);

    await store.delete(key);
    expect(await store.load(key)).toBeNull();
    expect(await store.load(subB)).toBeNull();
    expect(await store.listSubkeys(key)).toEqual([]);
    expect(await store.load(other)).toEqual([userEntry(4)]);
    expect(await store.load({ ...other, subpath: "subagents/a" })).toEqual([
      userEntry(5),
    ]);
    expect(await store.load(otherProject)).toEqual([userEntry(6)]);
    expect(await keysOf(base)).toHaveLength(3);
  });

  test("delete of a transcript that does not exist is a no-op", async () => {
    const store = makeStore();
    await expect(store.delete(key)).resolves.toBeUndefined();
    await expect(
      store.delete({ ...key, subpath: "subagents/none" }),
    ).resolves.toBeUndefined();
  });

  test("after delete, appending the same key starts a new transcript", async () => {
    const store = makeStore();
    await store.append(key, [userEntry(1)]);
    await store.delete(key);
    await store.append(key, [userEntry(2)]);
    expect(await store.load(key)).toEqual([userEntry(2)]);
  });
});

describe("A8 concurrent appends in one process", () => {
  test("Promise.all appends on one key all land, in call order, on a service with the list-then-write race", async () => {
    const racy = new RacyArtifactService();
    const store = makeStore(racy);
    const batches = Array.from({ length: 8 }, (_, i) => [userEntry(i)]);
    await Promise.all(batches.map((batch) => store.append(key, batch)));
    expect(await store.load(key)).toEqual(batches.flat());
    expect(racy.maxInFlight).toBe(1);
  });

  test("appends on different keys may overlap, and one failing append does not block the next on its key", async () => {
    const racy = new RacyArtifactService();
    const store = makeStore(racy);
    await Promise.all([
      store.append(key, [userEntry(1)]),
      store.append({ ...key, sessionId: "s2" }, [userEntry(2)]),
      store.append({ ...key, subpath: "subagents/a" }, [userEntry(3)]),
    ]);
    expect(racy.maxInFlight).toBeGreaterThan(1);

    let failNext = true;
    const flaky = new InMemoryArtifactService();
    const realSave = flaky.saveArtifact.bind(flaky);
    flaky.saveArtifact = (request) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("boom"));
      }
      return realSave(request);
    };
    const flakyStore = makeStore(flaky);
    const first = flakyStore.append(key, [userEntry(1)]);
    const second = flakyStore.append(key, [userEntry(2)]);
    await expect(first).rejects.toThrow("boom");
    await second;
    expect(await flakyStore.load(key)).toEqual([userEntry(2)]);
  });

  test("a concurrent append and delete of one key are serialized in call order", async () => {
    const racy = new RacyArtifactService();
    const store = makeStore(racy);
    await store.append(key, [userEntry(0)]);
    await Promise.all([
      store.append(key, [userEntry(1)]),
      store.delete(key),
      store.append(key, [userEntry(2)]),
    ]);
    expect(await store.load(key)).toEqual([userEntry(2)]);
  });
});

describe("A9 corrupt versions", () => {
  async function seeded() {
    const base = new InMemoryArtifactService();
    const store = makeStore(base);
    await store.append(key, [userEntry(1)]);
    const [filename] = await keysOf(base);
    return { base, store, filename: filename as string };
  }
  test("a version that is not JSONL rejects load", async () => {
    const { base, store, filename } = await seeded();
    await base.saveArtifact({
      ...SCOPE,
      filename,
      artifact: { text: "not json at all" },
      customMetadata: { format: "claude-session.v1", entries: 1, mtime: 1 },
    });
    await expect(store.load(key)).rejects.toMatchObject({
      code: "SESSION_STORE_CORRUPT_VERSION",
    });
    await expect(store.load(key)).rejects.toThrow(AdkArtifactSessionStoreError);
  });

  test("a line that is JSON but not an object rejects load", async () => {
    for (const text of ["[1,2]", "42", '"str"', "null", '{"a":1}\n[2]']) {
      const { base, store, filename } = await seeded();
      await base.saveArtifact({
        ...SCOPE,
        filename,
        artifact: { text },
        customMetadata: { format: "claude-session.v1", entries: 1, mtime: 1 },
      });
      await expect(store.load(key)).rejects.toMatchObject({
        code: "SESSION_STORE_CORRUPT_VERSION",
      });
    }
  });

  test("a version with the wrong or missing format rejects load", async () => {
    for (const customMetadata of [
      { format: "claude-session.v2", entries: 1, mtime: 1 },
      { format: "something-else" },
      {},
      undefined,
    ]) {
      const { base, store, filename } = await seeded();
      await base.saveArtifact({
        ...SCOPE,
        filename,
        artifact: { text: JSON.stringify(userEntry(2)) },
        customMetadata,
      });
      await expect(store.load(key)).rejects.toMatchObject({
        code: "SESSION_STORE_CORRUPT_VERSION",
      });
    }
  });

  test("a version with no readable content rejects load", async () => {
    const { base, store, filename } = await seeded();
    await base.saveArtifact({
      ...SCOPE,
      filename,
      artifact: {
        inlineData: { data: "AAAA", mimeType: "application/octet-stream" },
      },
      customMetadata: { format: "claude-session.v1", entries: 1, mtime: 1 },
    });
    await expect(store.load(key)).rejects.toMatchObject({
      code: "SESSION_STORE_CORRUPT_VERSION",
    });
  });

  test("a listed version that cannot be loaded rejects load instead of being skipped", async () => {
    const { base, filename } = await seeded();
    await base.saveArtifact({
      ...SCOPE,
      filename,
      artifact: { text: JSON.stringify(userEntry(2)) },
      customMetadata: { format: "claude-session.v1", entries: 1, mtime: 1 },
    });
    const realLoad = base.loadArtifact.bind(base);
    base.loadArtifact = (request) =>
      request.version === 1 ? Promise.resolve(undefined) : realLoad(request);
    const store = makeStore(base);
    await expect(store.load(key)).rejects.toMatchObject({
      code: "SESSION_STORE_CORRUPT_VERSION",
    });
  });

  test("a version the service lists without metadata rejects load (the File service drops unreadable metadata)", async () => {
    const { base, filename } = await seeded();
    await base.saveArtifact({
      ...SCOPE,
      filename,
      artifact: { text: JSON.stringify(userEntry(2)) },
      customMetadata: { format: "claude-session.v1", entries: 1, mtime: 1 },
    });
    const realList = base.listArtifactVersions.bind(base);
    base.listArtifactVersions = async (request) =>
      (await realList(request)).filter((item) => item.version !== 1);
    const store = makeStore(base);
    await expect(store.load(key)).rejects.toMatchObject({
      code: "SESSION_STORE_CORRUPT_VERSION",
    });
  });

  test("a blank line between entries is tolerated, a trailing newline too", async () => {
    const { base, store, filename } = await seeded();
    await base.saveArtifact({
      ...SCOPE,
      filename,
      artifact: {
        text: `${JSON.stringify(userEntry(2))}\n\n${JSON.stringify(userEntry(3))}\n`,
      },
      customMetadata: { format: "claude-session.v1", entries: 2, mtime: 1 },
    });
    expect(await store.load(key)).toEqual([
      userEntry(1),
      userEntry(2),
      userEntry(3),
    ]);
  });
});

describe("A10 key and entry errors match SqliteSessionStore", () => {
  const badKeys: Array<[string, unknown]> = [
    ["empty projectKey", { projectKey: "", sessionId: "s" }],
    ["empty sessionId", { projectKey: "p", sessionId: "" }],
    ["empty subpath", { projectKey: "p", sessionId: "s", subpath: "" }],
    ["numeric projectKey", { projectKey: 1, sessionId: "s" }],
    ["numeric subpath", { projectKey: "p", sessionId: "s", subpath: 3 }],
    ["missing key", undefined],
  ];
  const cyclic: Record<string, unknown> = { type: "t" };
  cyclic.self = cyclic;
  const badEntries: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "text"],
    ["an array", [1]],
    ["a number", 5],
    ["a bigint", { type: "t", n: 10n }],
    ["a cycle", cyclic],
    ["toJSON returning undefined", { type: "t", toJSON: () => undefined }],
    ["toJSON returning a string", { type: "t", toJSON: () => "x" }],
  ];

  async function code(
    run: () => Promise<unknown>,
  ): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  }

  test("every bad key gives the same code on append, load, listSubkeys and delete as the SQLite store", async () => {
    const adk = makeStore();
    const sqlite = new SqliteSessionStore({ path: ":memory:" });
    try {
      for (const [name, badKey] of badKeys) {
        const k = badKey as SessionKey;
        const runs: Array<[string, (s: SessionStore) => Promise<unknown>]> = [
          ["append", (s) => s.append(k, [userEntry(1)])],
          ["load", (s) => s.load(k)],
          [
            "delete",
            (s) => (s.delete as NonNullable<SessionStore["delete"]>)(k),
          ],
          [
            "listSubkeys",
            (s) =>
              (s.listSubkeys as NonNullable<SessionStore["listSubkeys"]>)(
                k as { projectKey: string; sessionId: string },
              ),
          ],
        ];
        for (const [method, run] of runs) {
          const expected = await code(() => run(sqlite));
          expect(expected, `${name} ${method} (sqlite)`).toBe(
            "SESSION_STORE_INVALID_KEY",
          );
          expect(await code(() => run(adk)), `${name} ${method}`).toBe(
            expected,
          );
        }
      }
    } finally {
      sqlite.close();
    }
  });

  test("every bad entry gives the same code as the SQLite store, and stores nothing from the batch", async () => {
    const adk = makeStore();
    const sqlite = new SqliteSessionStore({ path: ":memory:" });
    try {
      for (const [name, entry] of badEntries) {
        const batch = [userEntry(1), entry as SessionStoreEntry];
        const expected = await code(() => sqlite.append(key, batch));
        expect(expected, `${name} (sqlite)`).toBe(
          "SESSION_STORE_INVALID_ENTRY",
        );
        expect(await code(() => adk.append(key, batch)), name).toBe(expected);
        expect(await adk.load(key), `${name}: nothing stored`).toBeNull();
      }
    } finally {
      sqlite.close();
    }
  });

  test("a JSON-cyclic entry keeps the serialization error as cause", async () => {
    const store = makeStore();
    const error = await store
      .append(key, [cyclic as SessionStoreEntry])
      .catch((e) => e);
    expect(error).toBeInstanceOf(AdkArtifactSessionStoreError);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});

describe("SDK interop and types", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  test("A15 the SDK's importSessionToStore copies a local transcript and its subagents into the ADK store, and load matches the source", async () => {
    const root = tempDir();
    process.env.CLAUDE_CONFIG_DIR = join(root, "config");
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const projectKey = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    // The SDK looks the transcript up under the natively resolved path, which
    // on Windows expands 8.3 short names such as RUNNER~1; the store key
    // keeps the form realpathSync returns.
    const layoutKey = realpathSync.native(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = join(root, "config", "projects", layoutKey);
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const entries = [
      {
        type: "user",
        uuid: "entry-1",
        sessionId,
        message: { role: "user", content: "héllo" },
      },
      {
        type: "assistant",
        uuid: "entry-2",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
      },
    ];
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
    const subEntry = {
      type: "user",
      uuid: "sub-1",
      sessionId,
      message: { role: "user", content: "sub" },
    };
    mkdirSync(join(projectDir, sessionId, "subagents"), { recursive: true });
    writeFileSync(
      join(projectDir, sessionId, "subagents", "agent-a1.jsonl"),
      `${JSON.stringify(subEntry)}\n`,
    );

    const base = new InMemoryArtifactService();
    const store = makeStore(base);
    await importSessionToStore(sessionId, store, { dir: cwd });
    expect(await store.load({ projectKey, sessionId })).toEqual(entries);
    const subkeys = await store.listSubkeys({ projectKey, sessionId });
    expect(subkeys).toHaveLength(1);
    expect(
      await store.load({
        projectKey,
        sessionId,
        subpath: subkeys[0] as string,
      }),
    ).toEqual([subEntry]);
    // A second import of the same session adds no rows (uuid idempotency).
    await importSessionToStore(sessionId, store, { dir: cwd });
    expect(await store.load({ projectKey, sessionId })).toEqual(entries);
  });

  test("A16 the store and the factory product are assignable to the SDK SessionStore and back", () => {
    type Assignable<From, To> = From extends To ? true : false;
    const checks: [
      Assignable<AdkArtifactSessionStore, SdkSessionStore>,
      Assignable<SdkSessionStore, SessionStore>,
      Assignable<
        ReturnType<ReturnType<typeof adkArtifactSessionStore>>,
        SdkSessionStore
      >,
      Assignable<SessionStore, SdkSessionStore>,
      Assignable<SdkSessionStoreEntry, SessionStoreEntry>,
    ] = [true, true, true, true, true];
    expect(checks.every(Boolean)).toBe(true);
    const asSdk: SdkSessionStore = makeStore();
    expect(typeof asSdk.append).toBe("function");
  });
});

describe("factory: adkArtifactSessionStore()", () => {
  function context(
    artifactService: SessionArtifactService | undefined,
    sessionId = SCOPE.sessionId,
  ): InvocationContext {
    return {
      artifactService,
      session: {
        id: sessionId,
        appName: SCOPE.appName,
        userId: SCOPE.userId,
        events: [],
      },
    } as unknown as InvocationContext;
  }

  test("uses context.artifactService, so two ADK sessions never mix", async () => {
    const base = new InMemoryArtifactService();
    const factory = adkArtifactSessionStore();
    const s1 = factory({
      context: context(scoped(base, { ...SCOPE, sessionId: "one" }), "one"),
    });
    const s2 = factory({
      context: context(scoped(base, { ...SCOPE, sessionId: "two" }), "two"),
    });
    await s1.append(key, [userEntry(1)]);
    await s2.append(key, [userEntry(2)]);
    expect(await s1.load(key)).toEqual([userEntry(1)]);
    expect(await s2.load(key)).toEqual([userEntry(2)]);
    expect(
      await base.listArtifactKeys({ ...SCOPE, sessionId: "one" }),
    ).toHaveLength(1);
    expect(
      await base.listArtifactKeys({ ...SCOPE, sessionId: "two" }),
    ).toHaveLength(1);
    // A later run of the same ADK session sees the transcript.
    const again = factory({
      context: context(scoped(base, { ...SCOPE, sessionId: "one" }), "one"),
    });
    expect(await again.load(key)).toEqual([userEntry(1)]);
  });

  test("the artifactService option overrides the context and is scoped by context.session", async () => {
    const override = new InMemoryArtifactService();
    const ignored = new InMemoryArtifactService();
    const factory = adkArtifactSessionStore({ artifactService: override });
    const store = factory({ context: context(scoped(ignored), "adk-x") });
    await store.append(key, [userEntry(1)]);
    expect(
      await override.listArtifactKeys({ ...SCOPE, sessionId: "adk-x" }),
    ).toHaveLength(1);
    expect(await override.listArtifactKeys(SCOPE)).toHaveLength(0);
    expect(await ignored.listArtifactKeys(SCOPE)).toHaveLength(0);
  });

  test("the artifactService option works when the context has none", async () => {
    const override = new InMemoryArtifactService();
    const store = adkArtifactSessionStore({ artifactService: override })({
      context: context(undefined, "adk-y"),
    });
    await store.append(key, [userEntry(1)]);
    expect(
      await override.listArtifactKeys({ ...SCOPE, sessionId: "adk-y" }),
    ).toHaveLength(1);
  });

  test("with no artifact service anywhere the factory throws SESSION_STORE_NO_ARTIFACT_SERVICE", () => {
    const factory = adkArtifactSessionStore();
    let thrown: unknown;
    try {
      factory({ context: context(undefined) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdkArtifactSessionStoreError);
    expect((thrown as AdkArtifactSessionStoreError).code).toBe(
      "SESSION_STORE_NO_ARTIFACT_SERVICE",
    );
    expect((thrown as Error).message).toContain("artifact service");
  });

  test("maxVersionBytes passes through the factory to the store", async () => {
    const base = new InMemoryArtifactService();
    const store = adkArtifactSessionStore({ maxVersionBytes: 120 })({
      context: context(scoped(base)),
    });
    await store.append(
      key,
      Array.from({ length: 6 }, (_, i) =>
        userEntry(i, { pad: "z".repeat(30) }),
      ),
    );
    const [filename] = await keysOf(base);
    expect(
      (await base.listVersions({ ...SCOPE, filename: filename as string }))
        .length,
    ).toBeGreaterThan(1);
  });
});
