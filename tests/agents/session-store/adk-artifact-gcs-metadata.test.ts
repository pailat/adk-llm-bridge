import { describe, expect, test } from "bun:test";
import {
  type BaseArtifactService,
  InMemoryArtifactService,
  ScopedArtifactService,
} from "@google/adk";
import { AdkArtifactSessionStore } from "../../../src/agents/session-store/adk-artifacts.js";

// GcsArtifactService stores every customMetadata value as a string
// (stringifyMetadataValues). This wrapper does the same on save.
function stringifying(base: BaseArtifactService): BaseArtifactService {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "saveArtifact") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (request: { customMetadata?: Record<string, unknown> }) =>
        target.saveArtifact({
          ...request,
          customMetadata: Object.fromEntries(
            Object.entries(request.customMetadata ?? {}).map(([k, v]) => [
              k,
              String(v),
            ]),
          ),
        } as never);
    },
  });
}

const store = (base: BaseArtifactService) =>
  new AdkArtifactSessionStore({
    artifactService: new ScopedArtifactService(base, "app", "u1", "s1"),
  });

describe("metadata stringified like GCS", () => {
  test("listSessions keeps the real mtime, and load still works", async () => {
    const s = store(stringifying(new InMemoryArtifactService()));
    const key = { projectKey: "proj", sessionId: "a" };
    const before = Date.now();
    await s.append(key, [{ type: "user", uuid: "u1" }]);
    const sessions = await s.listSessions("proj");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("a");
    expect(sessions[0]?.mtime).toBeGreaterThanOrEqual(before);
    expect(sessions[0]?.mtime).toBeLessThanOrEqual(Date.now());
    expect(await s.load(key)).toEqual([{ type: "user", uuid: "u1" }]);
  });

  test("a non-numeric mtime string counts as 0, not NaN", async () => {
    const base = new InMemoryArtifactService();
    const s = store(base);
    await s.append({ projectKey: "proj", sessionId: "a" }, [{ type: "user" }]);
    const bad = new Proxy(base, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "listArtifactVersions") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (request: never) =>
          (await target.listArtifactVersions(request)).map((item) => ({
            ...item,
            customMetadata: { ...item.customMetadata, mtime: "soon" },
          }));
      },
    });
    const sessions = await store(bad).listSessions("proj");
    expect(sessions).toEqual([{ sessionId: "a", mtime: 0 }]);
  });
});
