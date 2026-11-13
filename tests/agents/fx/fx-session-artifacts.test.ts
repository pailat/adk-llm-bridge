import { describe, expect, test } from "bun:test";

const { fxArtifactSessionStore } = (await import(
  "../../../src/agents/session-store/fx-artifacts.js"
).catch(
  () => ({}),
)) as typeof import("../../../src/agents/session-store/fx-artifacts.js");

/** The two artifact-service calls the store uses, kept in memory. */
function memoryService() {
  const files = new Map<string, { text?: string; metadata?: unknown }>();
  return {
    files,
    service: {
      saveArtifact: async (request: {
        filename: string;
        artifact: { text?: string };
        customMetadata?: unknown;
      }) => {
        files.set(request.filename, {
          text: request.artifact.text,
          metadata: request.customMetadata,
        });
        return 0;
      },
      loadArtifact: async (request: { filename: string }) => {
        const item = files.get(request.filename);
        return item ? { text: item.text } : undefined;
      },
    },
  };
}

const bundle = {
  version: 1 as const,
  directories: ["blobs"],
  files: [{ path: "log.jsonl", base64: Buffer.from("a\n").toString("base64") }],
};

describe("fxArtifactSessionStore", () => {
  test("saves a bundle as one artifact and loads it back", async () => {
    const memory = memoryService();
    const store = fxArtifactSessionStore()({
      context: { artifactService: memory.service } as never,
    });
    await store.save("sR9HE8eyKMz1", bundle);
    expect([...memory.files.keys()]).toEqual([
      "fx-session.v1.sR9HE8eyKMz1.json",
    ]);
    expect(await store.load("sR9HE8eyKMz1")).toEqual(bundle);
  });

  test("load returns undefined when nothing is stored", async () => {
    const memory = memoryService();
    const store = fxArtifactSessionStore()({
      context: { artifactService: memory.service } as never,
    });
    expect(await store.load("nothing00001")).toBeUndefined();
  });

  test("throws without an artifact service", () => {
    expect(() => fxArtifactSessionStore()({ context: {} as never })).toThrow(
      /artifact service/,
    );
  });

  test("refuses a stored artifact that is not a bundle", async () => {
    const memory = memoryService();
    memory.files.set("fx-session.v1.sR9HE8eyKMz1.json", { text: "{}" });
    const store = fxArtifactSessionStore()({
      context: { artifactService: memory.service } as never,
    });
    await expect(store.load("sR9HE8eyKMz1")).rejects.toThrow(/bundle/);
  });

  test("refuses an id that is not a plain token", async () => {
    const memory = memoryService();
    const store = fxArtifactSessionStore()({
      context: { artifactService: memory.service } as never,
    });
    await expect(store.save("../x", bundle)).rejects.toThrow();
  });

  test("refuses a bundle over maxBytes", async () => {
    const memory = memoryService();
    const store = fxArtifactSessionStore({ maxBytes: 10 })({
      context: { artifactService: memory.service } as never,
    });
    await expect(store.save("sR9HE8eyKMz1", bundle)).rejects.toThrow(
      /maxBytes/,
    );
  });
});
