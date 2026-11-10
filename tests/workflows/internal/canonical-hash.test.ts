import { describe, expect, test } from "bun:test";
import {
  hashWorkflowSource,
  hashWorkflowValue,
  stableSerializeWorkflowValue,
} from "../../../src/workflows/checkpoint/hash.js";
import {
  canonicalDigest,
  canonicalJson,
  isRememberedLegacyDigest,
  legacyDigest,
  legacyJson,
  rememberLegacyDigest,
  resolveStoredDigest,
  sha256Digest,
} from "../../../src/workflows/internal/canonical-hash.js";
import {
  canonicalDigestSync,
  legacyDigestSync,
  sha256DigestSync,
} from "../../../src/workflows/internal/canonical-hash-node.js";
import { canonicalJson as resourceCanonicalJson } from "../../../src/workflows/resources/json.js";

// Expected digests were computed with `printf '%s' <json> | shasum -a 256`,
// independently of the code under test.
const GOLDEN = [
  {
    name: "nested objects and arrays",
    value: { b: 1, a: [1, { d: null, c: "x" }] },
    json: '{"a":[1,{"c":"x","d":null}],"b":1}',
    hex: "7346a20ad54b1f3db8b94180225e247ab2622b38422c1dd34eee6c6aee4bda6d",
  },
  {
    name: "mixed-case keys (uppercase sorts first by code unit)",
    value: { a: 2, B: 1 },
    json: '{"B":1,"a":2}',
    hex: "812e5e7fb7bb816dc477e91a136430192eadcf83ff303881298146e106ae0161",
  },
  {
    name: "integer-like keys sort as strings",
    value: { a: 3, 9: 2, 10: 1 },
    json: '{"10":1,"9":2,"a":3}',
    hex: "d6e62753b8541dd53e8db28349f1b082a93958576574f1b34b4fd86fbbd78916",
  },
  {
    name: "non-ASCII keys sort by UTF-16 code unit",
    value: { "～": 4, "😀": 3, é: 2, É: 1, z: 0 },
    json: '{"z":0,"É":1,"é":2,"😀":3,"～":4}',
    hex: "309363d0b53f78772e3873ae74529cfc78376872abdba37c1d7381ba6ab5d73a",
  },
  {
    name: "a bare string",
    value: "return 1",
    json: '"return 1"',
    hex: "1e593baef0f15f695aced807adff35b4726b4f2c494dede531473d4fe41a1b03",
  },
  {
    name: "undefined, NaN, Infinity, functions and -0",
    value: {
      a: undefined,
      b: Number.NaN,
      c: [undefined, Number.POSITIVE_INFINITY, () => 1],
      d: -0,
      e: Symbol("dropped"),
    },
    json: '{"b":null,"c":[null,null,null],"d":0}',
    hex: "6dba98f36084a9a5f54907113e5a227883b5dca93a68f87755e0cd8139d61914",
  },
  {
    name: "top-level undefined keeps the historical marker",
    value: undefined,
    json: "undefined",
    hex: "eb045d78d273107348b0300c01d29b7552d622abbc6faf81b3ec55359aa9950c",
  },
] as const;

describe("canonical hash", () => {
  for (const vector of GOLDEN) {
    test(`golden vector: ${vector.name}`, async () => {
      expect(canonicalJson(vector.value)).toBe(vector.json);
      expect(await canonicalDigest(vector.value)).toBe(`sha256:${vector.hex}`);
      expect(canonicalDigestSync(vector.value)).toBe(`sha256:${vector.hex}`);
      expect(await hashWorkflowValue(vector.value)).toBe(
        `sha256:${vector.hex}`,
      );
    });
  }

  test("orders keys by code unit, not localeCompare", () => {
    const value = { a: 2, B: 1 };
    expect(canonicalJson(value)).toBe('{"B":1,"a":2}');
    expect(legacyJson(value, "locale")).toBe('{"a":2,"B":1}');
    const keys = ["z", "É", "é", "😀", "～"];
    const record = Object.fromEntries(keys.map((key) => [key, key]));
    expect(Object.keys(JSON.parse(canonicalJson(record)))).toEqual(
      [...keys].sort(),
    );
    expect([...keys].sort()).not.toEqual(
      [...keys].sort((left, right) => left.localeCompare(right)),
    );
  });

  test("is independent of property insertion order at every depth", async () => {
    const left = { outer: { y: [{ q: 1, p: 2 }], x: true }, id: "n" };
    const right = { id: "n", outer: { x: true, y: [{ p: 2, q: 1 }] } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(await canonicalDigest(left)).toBe(await canonicalDigest(right));
    // Array order is significant.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("matches JSON.stringify value semantics", () => {
    const date = new Date(Date.UTC(2026, 0, 2));
    const value = {
      date,
      boxed: [new Number(1), new String("s"), new Boolean(false)],
      custom: { toJSON: (key: string) => `key:${key}` },
      nested: { list: [1, "two", null, { z: 1, a: [] }] },
    };
    expect(JSON.parse(canonicalJson(value))).toEqual(
      JSON.parse(JSON.stringify(value)),
    );
    expect(canonicalJson(value)).toContain('"custom":"key:custom"');
    expect(canonicalJson(date)).toBe(JSON.stringify(date));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(() => 1)).toBe("undefined");
  });

  test("rejects BigInt and cycles like JSON.stringify", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
    // A boxed BigInt throws too, as JSON.stringify does (not `{}`).
    const boxed = Object(1n);
    expect(() => JSON.stringify({ n: boxed })).toThrow(TypeError);
    expect(() => canonicalJson({ n: boxed })).toThrow(TypeError);
    expect(() => canonicalJson([boxed])).toThrow(TypeError);
    expect(() => canonicalJson(boxed)).toThrow(TypeError);
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    // A repeated (non-cyclic) reference is fine.
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe(
      '{"x":{"a":1},"y":{"a":1}}',
    );
    expect(() => stableSerializeWorkflowValue(cyclic)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_EXECUTION_ERROR" }),
    );
  });

  test("source hashes of strings are unchanged from the legacy form", async () => {
    expect(await hashWorkflowSource("return 1")).toBe(
      await legacyDigest("return 1", "locale"),
    );
  });

  test("legacy forms reproduce the pre-0.7.0 serializations", async () => {
    const value = { b: { D: 1, c: 2 }, a: [{ y: 1, X: 2 }] };
    expect(legacyJson(value, "locale")).toBe(
      '{"a":[{"X":2,"y":1}],"b":{"c":2,"D":1}}',
    );
    expect(legacyJson(value, "insertion")).toBe(JSON.stringify(value));
    expect(await legacyDigest(value, "insertion")).toBe(
      await sha256Digest(JSON.stringify(value)),
    );
    expect(legacyDigestSync(value, "locale")).toBe(
      await legacyDigest(value, "locale"),
    );
    expect(sha256DigestSync("abc")).toBe(await sha256Digest("abc"));
  });

  test("resolveStoredDigest keeps a matching legacy digest only", async () => {
    let legacyCalls = 0;
    const legacy = () => {
      legacyCalls++;
      return "sha256:legacy";
    };
    expect(await resolveStoredDigest(undefined, "sha256:new", legacy)).toBe(
      "sha256:new",
    );
    expect(await resolveStoredDigest("sha256:new", "sha256:new", legacy)).toBe(
      "sha256:new",
    );
    expect(legacyCalls).toBe(0);
    expect(
      await resolveStoredDigest("sha256:legacy", "sha256:new", legacy),
    ).toBe("sha256:legacy");
    expect(
      await resolveStoredDigest("sha256:other", "sha256:new", legacy),
    ).toBe("sha256:new");
  });

  test("remembered legacy aliases are exact and bounded", () => {
    rememberLegacyDigest("sha256:current-a", "sha256:legacy-a");
    rememberLegacyDigest("sha256:same", "sha256:same");
    expect(
      isRememberedLegacyDigest("sha256:legacy-a", "sha256:current-a"),
    ).toBe(true);
    expect(
      isRememberedLegacyDigest("sha256:current-a", "sha256:legacy-a"),
    ).toBe(false);
    expect(isRememberedLegacyDigest("sha256:same", "sha256:same")).toBe(false);
    for (let index = 0; index < 5000; index++) {
      rememberLegacyDigest(`sha256:fill-${index}`, `sha256:old-${index}`);
    }
    expect(
      isRememberedLegacyDigest("sha256:legacy-a", "sha256:current-a"),
    ).toBe(false);
    expect(
      isRememberedLegacyDigest("sha256:old-4999", "sha256:fill-4999"),
    ).toBe(true);
  });

  test("the workflow attempt identity hashes the same in both forms", async () => {
    // workflow-runtime.ts derives idempotency keys from this shape; equal
    // digests keep keys of attempts started before 0.7.0 stable.
    const identity = {
      protocol: "adk-llm-bridge/workflow-attempt-v1",
      workflowId: "wf",
      workflowVersion: "1",
      executionId: "exec",
      stepId: "step",
      agentName: "worker",
      agentRevision: "sha256:abc",
      inputHash: "sha256:def",
    };
    expect(await hashWorkflowValue(identity)).toBe(
      await legacyDigest(identity, "locale"),
    );
  });

  test("resources canonicalJson uses the canonical form", () => {
    expect(resourceCanonicalJson({ a: 1, B: { d: 1, C: 2 } })).toBe(
      '{"B":{"C":2,"d":1},"a":1}',
    );
  });
});
