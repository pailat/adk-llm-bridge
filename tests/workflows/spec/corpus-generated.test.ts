import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generatedCorpusCases } from "./corpus/generated.js";

/** Directory holding the valid and invalid run spec case files. */
const CORPUS_DIR = fileURLToPath(new URL("./corpus/", import.meta.url));

/**
 * The sha256 of `JSON.stringify` of each generated case, by group and name.
 * The values were taken from the corpus files these cases replace, so the
 * builders produce the same content those files held.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  "invalid/run_spec_issues_truncated.json":
    "3726b81d2c98a92dd4d52a4699a71ffb602c8213ce5fc9cc9bfae0a85e72c792",
  "invalid/run_spec_plan_rejected.json":
    "58035929857b25ab30aee39ec502dfa2ca613d7a56fbff27fdcab70eff2ecb1d",
  "invalid/run_spec_plan_too_large.json":
    "cb96f87f042e3a1217ea98c29ba08842c1f7a7c5d597ca117273d222609c5802",
  "invalid/run_spec_too_many_lanes.json":
    "90a62147399edb302b571222d9ad34caccfe942a95024f913196455ea2090315",
  "valid/wide-120-lanes.json":
    "9f4e845b018eecf5b628cf3117b90bbdb3b7aa1517d4916d78554aaf027249bc",
};

const cases = generatedCorpusCases();

describe("generated run spec corpus cases", () => {
  test("every pinned case is generated, and no other", () => {
    const keys = cases.map((item) => `${item.group}/${item.name}`).sort();
    expect(keys).toEqual(Object.keys(PINNED_SHA256).sort());
  });

  for (const item of cases) {
    const key = `${item.group}/${item.name}`;
    test(`${key} has its pinned content hash`, () => {
      const hash = createHash("sha256")
        .update(JSON.stringify(item.value))
        .digest("hex");
      expect(hash).toBe(PINNED_SHA256[key] ?? "");
    });
  }

  test("no generated case has the name of a corpus file", () => {
    const clashes = cases
      .map((item) => `${item.group}/${item.name}`)
      .filter((key) => existsSync(`${CORPUS_DIR}${key}`));
    expect(clashes).toEqual([]);
  });

  test("building the cases twice gives the same values", () => {
    expect(generatedCorpusCases()).toEqual(cases);
  });
});
