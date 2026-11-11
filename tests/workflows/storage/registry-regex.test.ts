import { describe, expect, test } from "bun:test";
import {
  getWorkflowCheckpointStoreFromUri,
  getWorkflowEventExporterFromUri,
  MAX_WORKFLOW_STORAGE_URI_LENGTH,
  redactWorkflowStorageUri,
} from "../../../src/workflows/storage/registry.js";

const PATHOLOGICAL = [
  `sqlite://${"a".repeat(50_000)}!`,
  `sqlite://x?${"?".repeat(7_000)}!`,
  `sqlite://x?${"a?".repeat(3_500)}!`,
  `sqlite://x?${"&".repeat(7_000)}!`,
  `sqlite://x?${"a=b&".repeat(2_000)}!`,
  `sqlite://${":".repeat(7_000)}@${"@".repeat(500)}!`,
];

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("storage URI parsing is linear", () => {
  test("redacting a pathological URI stays well under 50 ms", () => {
    for (const uri of PATHOLOGICAL) {
      expect(elapsed(() => redactWorkflowStorageUri(uri))).toBeLessThan(50);
    }
  });

  test("an over-long URI is redacted to the placeholder", () => {
    const uri = `sqlite://${"a".repeat(MAX_WORKFLOW_STORAGE_URI_LENGTH)}`;
    expect(redactWorkflowStorageUri(uri)).toBe("<invalid uri>");
  });

  test("a checkpoint URI over the length cap throws a typed error naming the limit", async () => {
    const uri = `sqlite://${"a".repeat(50_000)}!`;
    const start = performance.now();
    const error = await getWorkflowCheckpointStoreFromUri(uri).catch(
      (e: unknown) => e,
    );
    expect(performance.now() - start).toBeLessThan(50);
    expect(error).toMatchObject({ code: "WORKFLOW_STORAGE_INVALID_URI" });
    expect((error as Error).message).toContain(
      String(MAX_WORKFLOW_STORAGE_URI_LENGTH),
    );
    expect((error as Error).message).not.toContain("aaaa");
  });

  test("an event exporter URI over the length cap throws the same typed error", async () => {
    const error = await getWorkflowEventExporterFromUri(
      `file://${"a".repeat(MAX_WORKFLOW_STORAGE_URI_LENGTH + 1)}`,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "WORKFLOW_STORAGE_INVALID_URI" });
    expect((error as Error).message).toContain(
      String(MAX_WORKFLOW_STORAGE_URI_LENGTH),
    );
  });

  test("parsing a pathological URI under the cap returns or throws quickly", async () => {
    for (const uri of PATHOLOGICAL) {
      if (uri.length > MAX_WORKFLOW_STORAGE_URI_LENGTH) continue;
      const start = performance.now();
      await getWorkflowCheckpointStoreFromUri(uri).catch(() => undefined);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  test("secret query values are still redacted, others kept", () => {
    expect(
      redactWorkflowStorageUri(
        "postgres://u:pw@h/db?sslmode=require&api_key=abc&x=1#frag",
      ),
    ).toBe("postgres://u:***@h/db?sslmode=require&api_key=***&x=1#***");
  });
});
