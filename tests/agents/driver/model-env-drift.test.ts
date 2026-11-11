/**
 * The Claude model environment refusal is a pattern. This test reads the
 * Claude Code binary bundled with `@anthropic-ai/claude-agent-sdk` and fails
 * when it names a model variable the pattern does not refuse, so the next
 * Claude Code upgrade turns red here instead of leaving a silent gap.
 *
 * The binary is resolved through the SDK package, never the repo root: under
 * Bun's isolated install the platform package resolves only from the SDK.
 */

import { describe, expect, test } from "bun:test";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import {
  CLAUDE_MODEL_ENV_RULE,
  isClaudeModelEnv,
} from "../../../src/agents/driver/model.js";

/** What the resolver decided. */
export type Resolution =
  | { kind: "binary"; path: string }
  | { kind: "skip"; reason: string }
  | { kind: "fail"; reason: string };

interface SdkPackage {
  optionalDependencies?: Record<string, string>;
}

const SDK = "@anthropic-ai/claude-agent-sdk";

/**
 * Finds the bundled Claude Code binary through the SDK package.
 *
 * @param env - The process environment (`CI` decides skip or fail).
 * @param sdk - The SDK `package.json` and a resolver rooted at the SDK, or
 * `undefined` when the SDK is not installed.
 */
export function resolveBundledClaudeBinary(
  env: Readonly<Record<string, string | undefined>>,
  sdk:
    | {
        pkg: SdkPackage;
        resolve(request: string): string;
        platform?: string;
        arch?: string;
      }
    | undefined,
): Resolution {
  const strict = (reason: string): Resolution =>
    env.CI ? { kind: "fail", reason } : { kind: "skip", reason };
  if (!sdk) return strict(`${SDK} is not installed`);
  const platform = sdk.platform ?? process.platform;
  const arch = sdk.arch ?? process.arch;
  const listed = Object.keys(sdk.pkg.optionalDependencies ?? {}).filter(
    (name) =>
      name === `${SDK}-${platform}-${arch}` ||
      name === `${SDK}-${platform}-${arch}-musl`,
  );
  if (listed.length === 0) {
    return {
      kind: "skip",
      reason: `${SDK} lists no bundled binary for ${platform}-${arch}`,
    };
  }
  const file = platform === "win32" ? "claude.exe" : "claude";
  for (const name of listed) {
    try {
      return { kind: "binary", path: sdk.resolve(`${name}/${file}`) };
    } catch {
      // Try the next candidate (musl).
    }
  }
  return strict(`${listed.join(" or ")} is listed but cannot be resolved`);
}

function loadSdk(): Parameters<typeof resolveBundledClaudeBinary>[1] {
  try {
    const entry = realpathSync(createRequire(import.meta.url).resolve(SDK));
    const sdkRequire = createRequire(entry);
    const pkg = sdkRequire(`${SDK}/package.json`) as SdkPackage;
    return { pkg, resolve: (request) => sdkRequire.resolve(request) };
  } catch {
    return undefined;
  }
}

const CHUNK = 4 * 1024 * 1024;
const CARRY = 64;

/** Variable names in `path`, streamed in 4 MiB chunks with a 64 byte carry. */
function extractNames(path: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /\b(?:ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]*MODEL[A-Z0-9_]*\b/g,
    /\bCLAUDE_CODE_3P_[A-Z0-9_]+\b/g,
  ];
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(CHUNK);
    let carry = "";
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      const text = carry + buffer.toString("latin1", 0, read);
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) names.add(match[0]);
      }
      carry = text.slice(-CARRY);
    }
  } finally {
    closeSync(fd);
  }
  return names;
}

const MODELB_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

describe("the resolver", () => {
  const resolve = (request: string) => {
    throw new Error(`cannot resolve ${request}`);
  };
  test("an SDK that lists no package for this platform skips, even under CI", () => {
    const result = resolveBundledClaudeBinary(
      { CI: "1" },
      {
        pkg: { optionalDependencies: { [`${SDK}-linux-x64`]: "1" } },
        resolve,
        platform: "darwin",
        arch: "arm64",
      },
    );
    expect(result.kind).toBe("skip");
  });

  test("a listed package that cannot be resolved fails under CI", () => {
    const result = resolveBundledClaudeBinary(
      { CI: "1" },
      {
        pkg: { optionalDependencies: { [`${SDK}-darwin-arm64`]: "1" } },
        resolve,
        platform: "darwin",
        arch: "arm64",
      },
    );
    expect(result.kind).toBe("fail");
  });

  test("the same without CI skips with a reason", () => {
    const result = resolveBundledClaudeBinary(
      {},
      {
        pkg: { optionalDependencies: { [`${SDK}-darwin-arm64`]: "1" } },
        resolve,
        platform: "darwin",
        arch: "arm64",
      },
    );
    expect(result.kind).toBe("skip");
    expect((result as { reason: string }).reason).toContain("darwin-arm64");
  });

  test("a missing SDK fails under CI and skips without", () => {
    expect(resolveBundledClaudeBinary({ CI: "1" }, undefined).kind).toBe(
      "fail",
    );
    expect(resolveBundledClaudeBinary({}, undefined).kind).toBe("skip");
  });

  test("a resolvable package is used, and win32 asks for claude.exe", () => {
    const asked: string[] = [];
    const result = resolveBundledClaudeBinary(
      {},
      {
        pkg: { optionalDependencies: { [`${SDK}-win32-x64`]: "1" } },
        resolve: (request) => {
          asked.push(request);
          return `/x/${request}`;
        },
        platform: "win32",
        arch: "x64",
      },
    );
    expect(result).toEqual({
      kind: "binary",
      path: `/x/${SDK}-win32-x64/claude.exe`,
    });
    expect(asked).toEqual([`${SDK}-win32-x64/claude.exe`]);
  });
});

describe("the bundled Claude Code binary", () => {
  const resolution = resolveBundledClaudeBinary({ ...process.env }, loadSdk());
  if (resolution.kind === "fail") {
    test("the binary resolves under CI", () => {
      throw new Error(resolution.reason);
    });
    return;
  }
  if (resolution.kind === "skip") {
    console.warn(`model-env drift test skipped: ${resolution.reason}`);
    test.skip(`skipped: ${resolution.reason}`, () => {});
    return;
  }
  const names = extractNames(resolution.path);

  test("the extractor finds the MODELB names", () => {
    for (const name of MODELB_NAMES) expect(names.has(name)).toBe(true);
  });

  test("every model variable the binary names is refused", () => {
    const missed = [...names]
      .filter((name) => !isClaudeModelEnv(name))
      .filter((name) => !CLAUDE_MODEL_ENV_RULE.exceptions.includes(name));
    expect(missed).toEqual([]);
  });

  test("every exception is still named by the binary", () => {
    for (const name of CLAUDE_MODEL_ENV_RULE.exceptions) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("an exception is accepted by the predicate", () => {
    for (const name of CLAUDE_MODEL_ENV_RULE.exceptions) {
      expect(isClaudeModelEnv(name)).toBe(false);
    }
  });
});
