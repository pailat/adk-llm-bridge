/**
 * The CLI drivers refuse `args` that would widen the policy with a denylist
 * of flags and config keys. A CLI release can add a flag the list does not
 * know, so the list records what it was last reviewed against, and this test
 * compares that with the installed SDKs (read offline from their
 * `package.json`), the CLI each SDK bundles, and the peer ranges.
 *
 * When it fails: read `claude --help` and `codex exec --help` (and the Codex
 * config reference) of the new version, add every flag or key that widens
 * the sandbox, approvals, tools, MCP servers, plugins, subagents, directories
 * or where the session runs, then update the review record. See
 * docs/external-agent-isolation.md "Extra args".
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import { CLAUDE_CLI_PINNED_FLAGS_REVIEW } from "../../../src/agents/driver/claude-cli.js";
import { CODEX_CLI_PINNED_FLAGS_REVIEW } from "../../../src/agents/driver/codex-cli.js";

const ROOT = join(import.meta.dir, "../../..");
const RE_REVIEW = "re-review the flag denylist";
const peers = packageJson.peerDependencies as Record<string, string>;

interface PackageManifest {
  version?: string;
  claudeCodeVersion?: string;
}

function readManifest(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/** The installed package directory, symlinks resolved. */
function packageDir(name: string, from = ROOT): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`${name} is not installed; ${RE_REVIEW} once it is.`);
    }
    dir = parent;
  }
}

function mismatch(
  what: string,
  installed: string | undefined,
  reviewed: string,
): string[] {
  return installed === reviewed
    ? []
    : [
        `${what} is ${installed}, the denylist was reviewed with ${reviewed}: ${RE_REVIEW}`,
      ];
}

describe("pinned flag lists are reviewed against the installed CLIs", () => {
  test("Claude Code", () => {
    const review = CLAUDE_CLI_PINNED_FLAGS_REVIEW;
    const sdk = readManifest(packageDir(review.sdkPackage));
    expect([
      ...mismatch(
        `${review.sdkPackage} peer range`,
        peers[review.sdkPackage],
        review.sdkPeerRange,
      ),
      ...mismatch(
        `installed ${review.sdkPackage}`,
        sdk.version,
        review.reviewedSdkVersion,
      ),
      ...mismatch(
        `Claude Code bundled with ${review.sdkPackage}`,
        sdk.claudeCodeVersion,
        review.reviewedBundledCliVersion,
      ),
    ]).toEqual([]);
  });

  test("Codex", () => {
    const review = CODEX_CLI_PINNED_FLAGS_REVIEW;
    const sdkDir = packageDir(review.sdkPackage);
    const sdk = readManifest(sdkDir);
    // The SDK depends on `@openai/codex`; look it up from the SDK's own
    // directory, as Node would (Bun's isolated store links it beside the SDK).
    const cli = readManifest(packageDir("@openai/codex", sdkDir));
    expect([
      ...mismatch(
        `${review.sdkPackage} peer range`,
        peers[review.sdkPackage],
        review.sdkPeerRange,
      ),
      ...mismatch(
        `installed ${review.sdkPackage}`,
        sdk.version,
        review.reviewedSdkVersion,
      ),
      ...mismatch(
        `@openai/codex bundled with ${review.sdkPackage}`,
        cli.version,
        review.reviewedBundledCliVersion,
      ),
    ]).toEqual([]);
  });

  test("the isolation doc names the reviewed versions and the residuals", () => {
    const doc = readFileSync(
      join(ROOT, "docs/external-agent-isolation.md"),
      "utf8",
    );
    // Compare with line breaks folded, so rewrapping the doc does not matter.
    const section = doc
      .slice(doc.indexOf("## Extra args"), doc.indexOf("## Credentials"))
      .replace(/\s+/g, " ");
    expect(section).toContain(
      `Claude Code ${CLAUDE_CLI_PINNED_FLAGS_REVIEW.reviewedCliVersion}`,
    );
    expect(section).toContain(
      `codex-cli ${CODEX_CLI_PINNED_FLAGS_REVIEW.reviewedCliVersion}`,
    );
    expect(section).toContain("Pin the CLI version you run");
    expect(section).toContain("Do not offer `Agent`");
  });
});
