import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import {
  CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX,
  CLAUDE_NO_NETWORK_SANDBOX,
  planClaudeIsolation,
} from "../../../src/agents/driver/claude-isolation.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const ISOLATED = { inheritHostConfig: false, allowUnsandboxedShell: false };
const NO_NETWORK: ExternalAgentPermissionPolicy = {
  mode: "workspace-write",
  allowNetwork: false,
};

function request(
  permissions?: ExternalAgentPermissionPolicy,
  workingDirectory = "/repo",
): ExternalAgentRunRequest {
  return {
    provider: CLAUDE_PROVIDER,
    context: { input: "hi" } as never,
    workingDirectory,
    ...(permissions ? { permissions } : {}),
  };
}

function cliSettings(args: readonly string[]): Record<string, unknown> {
  const settings = args.find((arg) => arg.startsWith("--settings="));
  return JSON.parse(settings?.slice("--settings=".length) ?? "{}");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("allowLocalBinding (no-network sandbox)", () => {
  test("default: loopback binding stays denied", () => {
    const plan = planClaudeIsolation(NO_NETWORK, ISOLATED);
    expect(plan.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    expect(plan.sandbox?.network.allowLocalBinding).toBe(false);
    expect(
      planClaudeIsolation(NO_NETWORK, { ...ISOLATED, allowLocalBinding: false })
        .sandbox,
    ).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
  });

  test("opt-in: only allowLocalBinding changes; every host stays denied", () => {
    const plan = planClaudeIsolation(NO_NETWORK, {
      ...ISOLATED,
      allowLocalBinding: true,
    });
    expect(plan.sandbox).toEqual(CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX);
    expect(plan.networkSandbox).toBe("enforced");
    expect(CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX).toEqual({
      ...CLAUDE_NO_NETWORK_SANDBOX,
      network: {
        allowedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: true,
        allowAllUnixSockets: false,
      },
    });
    expect(Object.isFrozen(CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX)).toBe(true);
    expect(
      Object.isFrozen(CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX.network),
    ).toBe(true);
    // The default constant is untouched.
    expect(CLAUDE_NO_NETWORK_SANDBOX.network.allowLocalBinding).toBe(false);
  });

  test("no effect without the sandbox: allowNetwork true or allowUnsandboxedShell", () => {
    expect(
      planClaudeIsolation(
        { mode: "workspace-write", allowNetwork: true },
        { ...ISOLATED, allowLocalBinding: true },
      ).sandbox,
    ).toBeUndefined();
    const waived = planClaudeIsolation(NO_NETWORK, {
      inheritHostConfig: false,
      allowUnsandboxedShell: true,
      allowLocalBinding: true,
    });
    expect(waived.sandbox).toBeUndefined();
    expect(waived.networkSandbox).toBe("waived");
  });

  test("no shell on offer: no sandbox", () => {
    expect(
      planClaudeIsolation(NO_NETWORK, {
        ...ISOLATED,
        tools: ["Read"],
        allowLocalBinding: true,
      }).sandbox,
    ).toBeUndefined();
  });

  test("with allowedPaths the confined sandbox keeps the opt-in and the write roots", () => {
    const cache = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "node_modules",
      ".cache",
    );
    mkdirSync(cache, { recursive: true });
    const root = realpathSync(mkdtempSync(join(cache, "local-binding-")));
    dirs.push(root);
    const plan = planClaudeIsolation(
      { ...NO_NETWORK, allowedPaths: [root] },
      { ...ISOLATED, allowLocalBinding: true, workingDirectory: root },
    );
    expect(plan.shellPathsUnenforceable).toBeUndefined();
    expect(plan.sandbox).toMatchObject({
      network: { allowLocalBinding: true, allowedDomains: [] },
      filesystem: { allowWrite: [root] },
    });
  });

  test("Claude Agent SDK driver passes the opt-in in options.sandbox", () => {
    const off = new ClaudeAgentSdkDriver({ sdk: {} as never }).buildOptions(
      request(NO_NETWORK),
    );
    expect(off.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    const on = new ClaudeAgentSdkDriver({
      sdk: {} as never,
      allowLocalBinding: true,
    }).buildOptions(request(NO_NETWORK));
    expect(on.sandbox).toEqual(CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX);
  });

  test("Claude CLI driver passes the opt-in in --settings", () => {
    expect(
      cliSettings(new ClaudeCliDriver().buildArgs(request(NO_NETWORK))).sandbox,
    ).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    expect(
      cliSettings(
        new ClaudeCliDriver({ allowLocalBinding: true }).buildArgs(
          request(NO_NETWORK),
        ),
      ).sandbox,
    ).toEqual(CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX);
  });
});
