/**
 * Codex reads `approvals_reviewer` from `~/.codex/config.toml`. Set to
 * `"auto_review"` it turns the CLI's `--ask-for-approval never` into
 * `on-request` with a model reviewer, so a sandboxed run could ask for, and
 * get, an escalation outside the sandbox. Both Codex drivers pin the reviewer
 * to `"user"` outside `full-access`.
 */

import { describe, expect, test } from "bun:test";
import { mapPolicyToCodexArgs } from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import { CODEX_PROVIDER } from "../../../src/agents/index.js";
import type { ExternalAgentPermissionMode } from "../../../src/agents/permissions/schema.js";

const PIN = 'approvals_reviewer="user"';
const SANDBOXED: readonly ExternalAgentPermissionMode[] = [
  "read-only",
  "ask",
  "workspace-write",
];

function pinIndex(argv: readonly string[]): number {
  return argv.findIndex(
    (arg, index) => arg === "-c" && argv[index + 1] === PIN,
  );
}

describe("CodexCliDriver pins the approvals reviewer", () => {
  for (const mode of SANDBOXED) {
    test(`${mode}: -c ${PIN} after exec`, () => {
      for (const allowNetwork of [false, true]) {
        const argv = mapPolicyToCodexArgs({ mode, allowNetwork });
        expect(pinIndex(argv)).toBeGreaterThan(argv.indexOf("exec"));
      }
    });
  }

  test("full-access: no reviewer pin", () => {
    expect(pinIndex(mapPolicyToCodexArgs({ mode: "full-access" }))).toBe(-1);
  });
});

describe("CodexSdkDriver pins the approvals reviewer", () => {
  function overrides(mode: ExternalAgentPermissionMode, extra: string[] = []) {
    return new CodexSdkDriver({
      codexPathOverride: "/opt/codex",
    }).buildClientOptions(
      {
        provider: CODEX_PROVIDER,
        context: {} as never,
        permissions: { mode },
      },
      extra,
    ).configOverrides;
  }

  for (const mode of SANDBOXED) {
    test(`${mode}: last config override`, () => {
      expect(overrides(mode)).toEqual([PIN]);
      expect(overrides(mode, ["mcp_servers.x.enabled=false"])).toEqual([
        "mcp_servers.x.enabled=false",
        PIN,
      ]);
    });
  }

  test("full-access: no reviewer pin", () => {
    expect(overrides("full-access")).toBeUndefined();
  });

  test("a config.approvals_reviewer is overridden, since overrides come after config", () => {
    const options = new CodexSdkDriver({
      codexPathOverride: "/opt/codex",
      config: { approvals_reviewer: "auto_review" },
    }).buildClientOptions({
      provider: CODEX_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
    });
    expect(options.configOverrides).toEqual([PIN]);
  });
});
