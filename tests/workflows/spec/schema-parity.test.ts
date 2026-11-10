import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { RUN_SPEC_SCHEMA_ISSUE_CODES } from "../../../src/workflows/spec/issues.js";
import { runSpecJsonSchema } from "../../../src/workflows/spec/json-schema.js";
import { runSpecRegistry } from "../../../src/workflows/spec/registry.js";
import {
  RUN_SPEC_LIMITS,
  RunSpecSchema,
} from "../../../src/workflows/spec/schema.js";
import { parseRunSpecShape } from "../../../src/workflows/spec/shape.js";
import { readCorpusFiles } from "./corpus/read.js";
import { validSpec, wideSpec } from "./helpers.js";
import { EVALUATED_KEYWORDS, jsonSchemaAccepts } from "./json-schema-eval.js";

/** Codes of the input guard: the schema cannot express them. */
const GUARD_CODES: readonly string[] = [
  "RUN_SPEC_INPUT_NOT_JSON",
  "RUN_SPEC_INPUT_TOO_LARGE",
  "RUN_SPEC_INPUT_TOO_DEEP",
];

/** A named input for the parity check. */
interface Sample {
  readonly name: string;
  readonly spec: unknown;
}

/** Every `spec` of the valid and invalid corpus cases. */
function corpusSamples(): Sample[] {
  const samples: Sample[] = [];
  for (const file of readCorpusFiles()) {
    const json: unknown = JSON.parse(file.text);
    const spec =
      typeof json === "object" && json !== null && "spec" in json
        ? (json as { spec: unknown }).spec
        : undefined;
    samples.push({ name: `${file.group}/${file.name}`, spec });
  }
  return samples;
}

/** Deep copy of plain JSON. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A copy of the valid spec with one value set at a path (undefined deletes). */
function mutated(path: readonly (string | number)[], value: unknown): unknown {
  const root = clone(validSpec()) as unknown as Record<string, unknown>;
  let node: Record<string | number, unknown> = root;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1] as string | number;
  if (value === undefined) {
    delete node[last];
  } else {
    node[last] = value;
  }
  return root;
}

/** The expected verdict: no shape issue of a schema-scope code. */
function shapeAccepts(spec: unknown): boolean | "guard" {
  const issues: Parameters<typeof parseRunSpecShape>[1] = [];
  parseRunSpecShape(spec, issues);
  if (issues.some((issue) => GUARD_CODES.includes(issue.code))) {
    return "guard";
  }
  const scope: readonly string[] = RUN_SPEC_SCHEMA_ISSUE_CODES;
  return !issues.some((issue) => scope.includes(issue.code));
}

/** Generated inputs around the valid spec: one broken field at a time. */
function generatedSamples(): Sample[] {
  const out: Sample[] = [{ name: "valid spec", spec: validSpec() }];
  const add = (name: string, spec: unknown) => out.push({ name, spec });
  const long = (n: number) => "a".repeat(n);

  for (const value of [null, 1, "x", [], true]) {
    add(`root is ${JSON.stringify(value)}`, value);
  }
  for (const key of Object.keys(validSpec())) {
    add(`root without ${key}`, mutated([key], undefined));
    add(`root ${key} null`, mutated([key], null));
  }
  add("root extra key", { ...validSpec(), extra: 1 });
  add("version 2", mutated(["specVersion"], 2));
  add("version string", mutated(["specVersion"], "1"));
  add("version 1.5", mutated(["specVersion"], 1.5));
  add("version missing", mutated(["specVersion"], undefined));

  for (const id of [
    "",
    "-a",
    "a b",
    "a/b",
    "é",
    long(256),
    long(257),
    "a:b+c",
  ]) {
    add(
      `workflowId ${id.length > 20 ? id.length : id}`,
      mutated(["workflowId"], id),
    );
    add(
      `taskId ${id.length > 20 ? id.length : id}`,
      mutated(["lanes", 0, "taskId"], id),
    );
  }
  add("workflowVersion 256", mutated(["workflowVersion"], long(256)));
  add("workflowVersion 257", mutated(["workflowVersion"], long(257)));
  add("workflowVersion number", mutated(["workflowVersion"], 1));

  for (const root of [".", "", "a/b", long(4096), long(4097), 1]) {
    add(
      `projectRoot ${String(root).slice(0, 8)}`,
      mutated(["projectRoot"], root),
    );
  }

  for (const maxUsd of [
    0,
    -1,
    0.01,
    1e9,
    "5",
    null,
    Number.MAX_VALUE,
    1e-300,
  ]) {
    add(`maxUsd ${String(maxUsd)}`, mutated(["budget", "maxUsd"], maxUsd));
  }
  add("budget extra key", mutated(["budget", "other"], 1));
  add("budget empty", mutated(["budget"], {}));

  for (const n of [0, 1, 256, 257, 1.5, -1, "2", null]) {
    add(`maxConcurrency ${String(n)}`, mutated(["maxConcurrency"], n));
  }

  const lane = clone(validSpec().lanes[0]);
  add("no lanes", mutated(["lanes"], []));
  add("lanes object", mutated(["lanes"], {}));
  add("lane null", mutated(["lanes", 0], null));
  add("1000 lanes", wideSpec(1000));
  add("1001 lanes", { ...validSpec(), lanes: wideSpec(1001).lanes });
  add("lane extra key", mutated(["lanes", 0, "owner"], "x"));
  for (const key of Object.keys(lane)) {
    add(`lane without ${key}`, mutated(["lanes", 0, key], undefined));
  }
  add("lane title empty", mutated(["lanes", 0, "title"], ""));
  add("lane title 256", mutated(["lanes", 0, "title"], long(256)));
  add("lane title 257", mutated(["lanes", 0, "title"], long(257)));
  for (const role of ["worker", "reviewer", "planner", "", "Worker", 1]) {
    add(`role ${String(role)}`, mutated(["lanes", 0, "role"], role));
  }
  const deps = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);
  add("dependsOn 256", mutated(["lanes", 0, "dependsOn"], deps(256)));
  add("dependsOn 257", mutated(["lanes", 0, "dependsOn"], deps(257)));
  add("dependsOn bad id", mutated(["lanes", 0, "dependsOn"], ["-x"]));
  add("dependsOn not array", mutated(["lanes", 0, "dependsOn"], "api"));
  const paths = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  add("allowedPaths 64", mutated(["lanes", 0, "allowedPaths"], paths(64)));
  add("allowedPaths 65", mutated(["lanes", 0, "allowedPaths"], paths(65)));
  add("allowedPaths empty", mutated(["lanes", 0, "allowedPaths"], []));
  add("allowedPaths empty entry", mutated(["lanes", 0, "allowedPaths"], [""]));
  add(
    "allowedPaths long entry",
    mutated(["lanes", 0, "allowedPaths"], [long(4097)]),
  );
  add("allowedPaths number entry", mutated(["lanes", 0, "allowedPaths"], [1]));

  const agent = ["lanes", 0, "agent"] as const;
  add("agent null", mutated([...agent], null));
  add("agent extra key", mutated([...agent, "x"], 1));
  for (const key of ["providerId", "model", "mode", "tools"]) {
    add(`agent without ${key}`, mutated([...agent, key], undefined));
  }
  for (const id of ["", "a b", "-a", long(64), long(65), "a+b", "a:b"]) {
    add(
      `provider ${id.length > 20 ? id.length : id}`,
      mutated([...agent, "providerId"], id),
    );
  }
  for (const model of ["", "a@b", "a/b+c", "-a", long(256), long(257), "a b"]) {
    add(
      `model ${model.length > 20 ? model.length : model}`,
      mutated([...agent, "model"], model),
    );
  }
  for (const mode of [
    "read-only",
    "workspace-write",
    "full-access",
    "ask",
    "",
    "READ-ONLY",
    1,
  ]) {
    add(`mode ${String(mode)}`, mutated([...agent, "mode"], mode));
  }
  add("allowNetwork true", mutated([...agent, "allowNetwork"], true));
  add("allowNetwork string", mutated([...agent, "allowNetwork"], "no"));
  add("allowNetwork null", mutated([...agent, "allowNetwork"], null));
  for (const tools of [
    [],
    ["Read"],
    ["a/b:c.d"],
    ["_x"],
    [""],
    ["-x"],
    ["a b"],
    [long(128)],
    [long(129)],
    [1],
    "Read",
  ]) {
    add(
      `tools ${JSON.stringify(tools).slice(0, 12)}`,
      mutated([...agent, "tools"], tools),
    );
  }
  add("tools 64", mutated([...agent, "tools"], paths(64)));
  add("tools 65", mutated([...agent, "tools"], paths(65)));

  const steps = ["lanes", 0, "steps"] as const;
  add("steps empty", mutated([...steps], {}));
  add("steps extra key", mutated([...steps, "x"], 1));
  add("testsFirst string", mutated([...steps, "testsFirst"], "yes"));
  add(
    "review none with extra",
    mutated([...steps, "review"], { kind: "none", x: 1 }),
  );
  add("review unknown kind", mutated([...steps, "review"], { kind: "human" }));
  add("review without kind", mutated([...steps, "review"], {}));
  const reviewer = {
    kind: "agent",
    providerId: "codex",
    model: "gpt-5.5",
    maxChangeRounds: 1,
  };
  for (const rounds of [0, 10, 11, -1, 1.5, "1", null]) {
    add(
      `rounds ${String(rounds)}`,
      mutated([...steps, "review"], { ...reviewer, maxChangeRounds: rounds }),
    );
  }
  for (const key of Object.keys(reviewer)) {
    const copy: Record<string, unknown> = { ...reviewer };
    delete copy[key];
    add(`review agent without ${key}`, mutated([...steps, "review"], copy));
  }
  add(
    "review agent bad provider",
    mutated([...steps, "review"], { ...reviewer, providerId: "a b" }),
  );
  add(
    "review agent bad model",
    mutated([...steps, "review"], { ...reviewer, model: "" }),
  );
  add(
    "review none with agent fields",
    mutated([...steps, "review"], { ...reviewer, kind: "none" }),
  );

  for (const names of [
    [],
    ["CI"],
    ["_A1"],
    ["1A"],
    ["A-B"],
    [""],
    [long(128)],
    [long(129)],
    [1],
  ]) {
    add(`env ${JSON.stringify(names).slice(0, 12)}`, mutated(["env"], names));
  }
  add(
    "env 64",
    mutated(
      ["env"],
      Array.from({ length: 64 }, (_, i) => `E${i}`),
    ),
  );
  add(
    "env 65",
    mutated(
      ["env"],
      Array.from({ length: 65 }, (_, i) => `E${i}`),
    ),
  );
  add("env absent", mutated(["env"], undefined));

  const ext = (value: unknown) => ({ ...validSpec(), extensions: value });
  for (const key of [
    "x-vendor",
    "x-a-b",
    "x-",
    "x--a",
    "X-a",
    "vendor",
    "x-A",
    "x-a_b",
    "x-ab-",
    long(64),
    `x-${long(61)}`,
    `x-${long(62)}`,
    "",
  ]) {
    add(
      `extension key ${key.length > 20 ? key.length : key}`,
      ext({ [key]: 1 }),
    );
    add(
      `lane extension key ${key.length > 20 ? key.length : key}`,
      mutated(["lanes", 0, "extensions"], { [key]: 1 }),
    );
  }
  add("extensions empty", ext({}));
  add("extensions null", ext(null));
  add("extensions array", ext([]));
  add(
    "extension values",
    ext({ "x-a": { deep: [1, "a", null, true] }, "x-b": null }),
  );

  const gates = ["gates"] as const;
  add("gates empty", mutated([...gates], {}));
  add("gates extra key", mutated([...gates, "x"], 1));
  add("qa empty", mutated([...gates, "qa"], []));
  add(
    "qa 64",
    mutated(
      [...gates, "qa"],
      Array.from({ length: 64 }, (_, i) => ({ id: `q${i}`, command: ["a"] })),
    ),
  );
  add(
    "qa 65",
    mutated(
      [...gates, "qa"],
      Array.from({ length: 65 }, (_, i) => ({ id: `q${i}`, command: ["a"] })),
    ),
  );
  add("qa not array", mutated([...gates, "qa"], {}));
  add("qa extra key", mutated([...gates, "qa", 0, "x"], 1));
  for (const key of ["id", "command"]) {
    add(`qa without ${key}`, mutated([...gates, "qa", 0, key], undefined));
  }
  for (const id of ["", "a b", "-a", long(256), long(257)]) {
    add(
      `qa id ${id.length > 20 ? id.length : id}`,
      mutated([...gates, "qa", 0, "id"], id),
    );
  }
  const command = (c: unknown) => mutated([...gates, "qa", 0, "command"], c);
  add("command empty", command([]));
  add("command one", command(["a"]));
  add("command control char", command(["a\u0000b"]));
  add("command newline", command(["a\nb"]));
  add("command DEL", command(["a\u007fb"]));
  add("command C1", command(["a\u0085b"]));
  add("command unicode", command(["é", "日本"]));
  add("command emoji", command(["😀"]));
  add("command empty arg", command([""]));
  add("command long arg", command([long(4096)]));
  add("command too long arg", command([long(4097)]));
  add("command 64 args", command(Array.from({ length: 64 }, () => "a")));
  add("command 65 args", command(Array.from({ length: 65 }, () => "a")));
  add("command number", command([1]));
  add("command string", command("bun test"));
  for (const publish of [
    { kind: "none" },
    { kind: "none", hitl: true },
    { kind: "commit", hitl: true },
    { kind: "commit", hitl: false },
    { kind: "commit" },
    { kind: "integration", hitl: true },
    { kind: "integration", hitl: "true" },
    { kind: "merge", hitl: true },
    { kind: "none", x: 1 },
    { hitl: true },
    {},
    null,
    "commit",
  ]) {
    add(
      `publish ${JSON.stringify(publish)}`,
      mutated([...gates, "publish"], publish),
    );
  }
  add("gates without publish", mutated([...gates, "publish"], undefined));
  add("gates without qa", mutated([...gates, "qa"], undefined));

  // Prototype-like keys arriving through JSON text.
  add(
    "__proto__ key",
    JSON.parse(`{"__proto__":{"a":1},${JSON.stringify(validSpec()).slice(1)}`),
  );
  add("constructor key", { ...validSpec(), constructor: 1 });
  add(
    "__proto__ in lane",
    JSON.parse(
      JSON.stringify(validSpec()).replace(
        '"taskId":"api"',
        '"__proto__":{},"taskId":"api"',
      ),
    ),
  );
  add("__proto__ in extensions", ext(JSON.parse('{"__proto__":1}')));
  // Lengths count code points on both sides: an astral character such as an
  // emoji is one character for the schema and for the shape parser.
  const astral = (count: number): string => "\u{1F600}".repeat(count);
  add(
    "lane title of 256 astral characters",
    mutated(["lanes", 0, "title"], astral(RUN_SPEC_LIMITS.maxTitleLength)),
  );
  add(
    "lane title of 257 astral characters",
    mutated(["lanes", 0, "title"], astral(RUN_SPEC_LIMITS.maxTitleLength + 1)),
  );
  add(
    "lane title mixing ASCII and astral characters at the limit",
    mutated(
      ["lanes", 0, "title"],
      `${"t".repeat(RUN_SPEC_LIMITS.maxTitleLength - 1)}${astral(1)}`,
    ),
  );
  add(
    "path of astral characters at the limit",
    mutated(
      ["lanes", 0, "allowedPaths", 0],
      `s/${astral(RUN_SPEC_LIMITS.maxPathLength - 2)}`,
    ),
  );
  add(
    "path of astral characters one over the limit",
    mutated(
      ["lanes", 0, "allowedPaths", 0],
      `s/${astral(RUN_SPEC_LIMITS.maxPathLength - 1)}`,
    ),
  );
  add(
    "QA argument of astral characters at the limit",
    mutated(
      ["gates", "qa", 0, "command", 1],
      astral(RUN_SPEC_LIMITS.maxCommandArgLength),
    ),
  );
  add(
    "QA argument of astral characters one over the limit",
    mutated(
      ["gates", "qa", 0, "command", 1],
      astral(RUN_SPEC_LIMITS.maxCommandArgLength + 1),
    ),
  );
  add("two lanes same id", {
    ...validSpec(),
    lanes: [validSpec().lanes[0], validSpec().lanes[0]],
  });
  return out;
}

const schema = runSpecJsonSchema as Record<string, unknown>;
const samples = [...corpusSamples(), ...generatedSamples()];

/** Collects every property schema (and the owning object) under a node. */
function missingDescriptions(
  node: unknown,
  path: string,
  found: string[],
): void {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      missingDescriptions(item, `${path}/${i}`, found);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  const props = record.properties;
  if (typeof props === "object" && props !== null) {
    for (const [name, sub] of Object.entries(props)) {
      const described = (sub as Record<string, unknown>).description;
      const ref = (sub as Record<string, unknown>).$ref;
      if (typeof described !== "string" || described.length === 0) {
        found.push(
          `${path}/properties/${name}${typeof ref === "string" ? ` (${ref})` : ""}`,
        );
      }
    }
  }
  for (const [key, value] of Object.entries(record)) {
    missingDescriptions(value, `${path}/${key}`, found);
  }
}

/** Every keyword name used anywhere in a schema, not counting property names. */
function keywordsUsed(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) keywordsUsed(item, into);
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    into.add(key);
    if (key === "properties" || key === "$defs") {
      for (const sub of Object.values(value as object)) keywordsUsed(sub, into);
    } else {
      keywordsUsed(value, into);
    }
  }
}

describe("runSpecJsonSchema document", () => {
  test("is deeply frozen, so a consumer cannot change the shared document", () => {
    const unfrozen: string[] = [];
    const visit = (value: unknown, at: string): void => {
      if (typeof value !== "object" || value === null) return;
      if (!Object.isFrozen(value)) unfrozen.push(at);
      for (const [key, child] of Object.entries(value)) {
        visit(child, `${at}/${key}`);
      }
    };
    visit(runSpecJsonSchema, "#");
    expect(unfrozen).toEqual([]);
    expect(() => {
      (runSpecJsonSchema as Record<string, unknown>).title = "changed";
    }).toThrow(TypeError);
  });

  test("declares draft 2020-12, a title and a description at the root", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(typeof schema.title).toBe("string");
    expect(typeof schema.description).toBe("string");
  });

  test("equals the input-side output of z.toJSONSchema except for descriptions copied onto reference properties", () => {
    const expected = z.toJSONSchema(RunSpecSchema, {
      target: "draft-2020-12",
      io: "input",
      metadata: runSpecRegistry,
    });
    const strip = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(strip);
      if (typeof node !== "object" || node === null) return node;
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        copy[key] = strip(value);
      }
      if (typeof copy.$ref === "string") {
        copy.description = undefined;
      }
      return copy;
    };
    expect(JSON.parse(JSON.stringify(strip(schema)))).toEqual(
      JSON.parse(JSON.stringify(strip(expected))),
    );
  });

  test("is plain JSON that survives a stringify round trip", () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  test("every property carries a non-empty description", () => {
    const found: string[] = [];
    missingDescriptions(schema, "", found);
    expect(Object.keys(schema).length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });

  test("uses only keywords the test evaluator supports", () => {
    const used = new Set<string>();
    keywordsUsed(schema, used);
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((key) => !EVALUATED_KEYWORDS.has(key))).toEqual([]);
  });

  test("closes every object with additionalProperties false except the extension maps", () => {
    const open: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          visit(item, `${path}/${i}`);
        });
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      const isObjectSchema =
        obj.type === "object" || obj.properties !== undefined;
      if (isObjectSchema) {
        const closed = obj.additionalProperties === false;
        const extensionMap =
          obj.properties === undefined &&
          typeof obj.additionalProperties === "object" &&
          obj.propertyNames !== undefined;
        if (!closed && !extensionMap) open.push(path);
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key === "properties" || key === "$defs") {
          for (const [name, sub] of Object.entries(value as object)) {
            visit(sub, `${path}/${key}/${name}`);
          }
        } else {
          visit(value, `${path}/${key}`);
        }
      }
    };
    visit(schema, "");
    expect(open).toEqual([]);
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    const maps = Object.entries(defs)
      .filter(([, def]) => def.type === "object" && def.propertyNames)
      .map(([name]) => name);
    expect(maps).toEqual(["RunSpecExtensions"]);
  });

  test("every description copied onto a reference equals the description of its definition", () => {
    const raw = z.toJSONSchema(RunSpecSchema, {
      target: "draft-2020-12",
      io: "input",
      metadata: runSpecRegistry,
    });
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    let checked = 0;
    const visit = (node: unknown, original: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      if (typeof original !== "object" || original === null) return;
      const obj = node as Record<string, unknown>;
      const orig = original as Record<string, unknown>;
      if (
        typeof obj.$ref === "string" &&
        orig.description === undefined &&
        obj.description !== undefined
      ) {
        const target = defs[obj.$ref.replace("#/$defs/", "")];
        expect(String(obj.description)).toBe(String(target?.description));
        checked++;
      }
      for (const [key, value] of Object.entries(obj)) {
        visit(value, orig[key]);
      }
    };
    visit(schema, raw);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("evaluator self-check", () => {
  test("rejects an unsupported keyword instead of ignoring it", () => {
    expect(() => jsonSchemaAccepts({ allOf: [] }, 1)).toThrow();
  });

  test("counts code points and applies patterns with the Unicode flag", () => {
    expect(jsonSchemaAccepts({ type: "string", maxLength: 1 }, "😀")).toBe(
      true,
    );
    expect(
      jsonSchemaAccepts({ type: "string", pattern: "^\\P{Cc}+$" }, "é"),
    ).toBe(true);
    expect(
      jsonSchemaAccepts({ type: "string", pattern: "^\\P{Cc}+$" }, "a\u0000"),
    ).toBe(false);
  });
});

/** The sample whose extension key is `__proto__`, checked on its own below. */
const PROTO_EXTENSION_CASE = "__proto__ in extensions";

describe("schema and shape parser parity", () => {
  test("the corpus and the generated cases are large enough to matter", () => {
    expect(samples.length).toBeGreaterThan(300);
  });

  test("accepts the valid spec and rejects an empty object", () => {
    expect(jsonSchemaAccepts(schema, validSpec())).toBe(true);
    expect(jsonSchemaAccepts(schema, {})).toBe(false);
  });

  test("accepts a spec exactly when the shape parser reports no schema-scope issue", () => {
    const disagreements: string[] = [];
    let compared = 0;
    for (const sample of samples) {
      const expected = shapeAccepts(sample.spec);
      if (expected === "guard") {
        continue;
      }
      compared++;
      const actual = jsonSchemaAccepts(schema, sample.spec);
      if (actual !== expected) {
        disagreements.push(
          `${sample.name}: schema ${actual ? "accepts" : "rejects"}, shape ${expected ? "accepts" : "rejects"}`,
        );
      }
    }
    expect(compared).toBeGreaterThan(250);
    expect(disagreements).toEqual([]);
  });

  test("the schema rejects a __proto__ extension key", () => {
    const sample = samples.find((s) => s.name === PROTO_EXTENSION_CASE);
    expect(sample).toBeDefined();
    expect(jsonSchemaAccepts(schema, sample?.spec)).toBe(false);
  });

  // zod's record parser skips a "__proto__" key before checking it against
  // the key pattern, so the shape parser checks that key itself.
  test("the shape parser rejects a __proto__ extension key", () => {
    const sample = samples.find((s) => s.name === PROTO_EXTENSION_CASE);
    expect(shapeAccepts(sample?.spec)).toBe(false);
  });

  test("rejects every invalid corpus case that lists a schema-scope code", () => {
    const scope: readonly string[] = RUN_SPEC_SCHEMA_ISSUE_CODES;
    const missed: string[] = [];
    for (const file of readCorpusFiles(["invalid"])) {
      const json = JSON.parse(file.text) as {
        spec: unknown;
        expectCodes: string[];
      };
      if (!json.expectCodes.some((code) => scope.includes(code))) continue;
      if (json.expectCodes.some((code) => GUARD_CODES.includes(code))) continue;
      if (jsonSchemaAccepts(schema, json.spec)) missed.push(file.name);
    }
    expect(missed).toEqual([]);
  });

  test("accepts every valid corpus case", () => {
    const rejected: string[] = [];
    for (const file of readCorpusFiles(["valid"])) {
      const json = JSON.parse(file.text) as { spec: unknown };
      if (!jsonSchemaAccepts(schema, json.spec)) rejected.push(file.name);
    }
    expect(rejected).toEqual([]);
  });

  test("leaves cross-field rules to the validator: a duplicate lane id and a dependency cycle pass the schema", () => {
    const duplicate = {
      ...validSpec(),
      lanes: [validSpec().lanes[0], validSpec().lanes[0]],
    };
    const cyclic = mutated(["lanes", 0, "dependsOn"], ["docs"]);
    expect(jsonSchemaAccepts(schema, duplicate)).toBe(true);
    expect(jsonSchemaAccepts(schema, cyclic)).toBe(true);
  });
});
