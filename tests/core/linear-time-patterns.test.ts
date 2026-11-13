import { describe, expect, it } from "bun:test";
import type { Content } from "@google/genai";
import { flattenContentsToPrompt } from "../../src/agents/runtime/content-collector.js";
import { isErrorPrefix } from "../../src/core/openai-compatible-llm.js";
import { CustomLlm } from "../../src/providers/custom/custom-llm.js";

// Inputs that made the old backtracking patterns quadratic. Each check must
// finish well inside the bound on any CI runner.
const LONG = 50_000;
const BOUND_MS = 500;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("isErrorPrefix", () => {
  it.each([
    ["ACME", true],
    ["MY_PROVIDER", true],
    ["_A", true],
    ["A_", true],
    ["0", true],
    ["", false],
    ["___", false],
    ["acme", false],
    ["MY-PROVIDER", false],
    ["CAFÉ", false],
  ])("%p -> %p", (prefix, expected) => {
    expect(isErrorPrefix(prefix)).toBe(expected);
  });

  it.each([
    ["50k zeros", "0".repeat(LONG), true],
    ["50k zeros then !", `${"0".repeat(LONG)}!`, false],
    ["50k underscores", "_".repeat(LONG), false],
    ["50k underscores then !", `${"_".repeat(LONG)}!`, false],
  ])("runs in linear time on %s", (_label, prefix, expected) => {
    const { value, ms } = timed(() => isErrorPrefix(prefix));
    expect(value).toBe(expected);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("a long custom provider name builds its prefix in linear time", () => {
    const { ms } = timed(
      () =>
        new CustomLlm({
          name: `${"0".repeat(LONG)}!`,
          model: "m",
          baseURL: "http://localhost:1/v1",
        }),
    );
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("flattenContentsToPrompt trailing whitespace", () => {
  const user = (text: string): Content => ({ role: "user", parts: [{ text }] });

  it("trims trailing whitespace and keeps inner whitespace", () => {
    expect(flattenContentsToPrompt([user("a  b \n\t  ")])).toBe("user:\na  b");
  });

  it.each([
    ["no-break space", "\u00a0"],
    ["byte order mark", "\ufeff"],
    ["ideographic space", "\u3000"],
    ["line separator", "\u2028"],
  ])("trims trailing non-ASCII whitespace (%s), as \\s does", (_label, ws) => {
    expect(flattenContentsToPrompt([user(`a ${ws}${ws}`)])).toBe("user:\na");
  });

  it("runs in linear time on text with many inner spaces", () => {
    const text = `a${" ".repeat(LONG)}b`;
    const { value, ms } = timed(() => flattenContentsToPrompt([user(text)]));
    expect(value).toBe(`user:\n${text}`);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("runs in linear time on text that ends in many spaces", () => {
    const { value, ms } = timed(() =>
      flattenContentsToPrompt([user(`a${" ".repeat(LONG)}`)]),
    );
    expect(value).toBe("user:\na");
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("trimEndOf (driver spawn)", () => {
  it("drops only the trailing run", async () => {
    const { trimEndOf } = await import("../../src/agents/driver/spawn.js");
    expect(trimEndOf("claude.exe. . ", ". ")).toBe("claude.exe");
    expect(trimEndOf("C:\\tools\\\\//", "\\/")).toBe("C:\\tools");
    expect(trimEndOf("a b", ". ")).toBe("a b");
    expect(trimEndOf(" . ", ". ")).toBe("");
  });

  it("stays linear on a long run that does not reach the end", async () => {
    const { trimEndOf } = await import("../../src/agents/driver/spawn.js");
    const input = `${" ".repeat(200_000)}x`;
    const started = performance.now();
    expect(trimEndOf(input, ". ")).toBe(input);
    expect(trimEndOf(`${"/".repeat(200_000)}x`, "\\/")).toHaveLength(200_001);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
