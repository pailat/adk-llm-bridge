import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalAgentDefinitionRegistry } from "../../../src/agents/agent-registry.js";
import { planClaudeIsolation } from "../../../src/agents/driver/claude-isolation.js";
import { mapPolicyToCodexArgs } from "../../../src/agents/driver/codex-cli.js";
import type { ExternalAgent } from "../../../src/agents/external-agent.js";
import { PlaceholderExternalAgentDriver } from "../../../src/agents/external-agent-driver.js";
import { networkAllowed } from "../../../src/agents/permissions/network.js";
import { ExternalAgentWorkflowFactory } from "../../../src/workflows/agents/external-agent-workflow-factory.js";

function registry() {
  return new ExternalAgentDefinitionRegistry([
    {
      provider: { id: "codex", name: "Codex" },
      createDriver: () => new PlaceholderExternalAgentDriver("codex"),
    },
  ]);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A host root with a sibling directory outside it. */
function layout(): { root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "factory-paths-")));
  dirs.push(base);
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
}

describe("workflow factory network default", () => {
  test("an agent without permissions, or without allowNetwork, runs with network off", () => {
    const factory = new ExternalAgentWorkflowFactory({ registry: registry() });
    const none = factory.create({ providerId: "codex", name: "none" })
      .agent as ExternalAgent;
    const unset = factory.create({
      providerId: "codex",
      name: "unset",
      config: { permissions: { mode: "workspace-write" } },
    }).agent as ExternalAgent;
    for (const agent of [none, unset]) {
      expect(networkAllowed(agent.permissions)).toBe(false);
      expect(
        planClaudeIsolation(agent.permissions, {
          inheritHostConfig: false,
          allowUnsandboxedShell: false,
        }).networkSandbox,
      ).toBe("enforced");
      expect(mapPolicyToCodexArgs(agent.permissions)).toContain(
        "sandbox_workspace_write.network_access=false",
      );
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "workflow factory roots follow symlinks",
  () => {
    test("a workingDirectory through a symlink that leaves the root is rejected", () => {
      const { root, outside } = layout();
      symlinkSync(outside, join(root, "escape"));
      const factory = new ExternalAgentWorkflowFactory({
        registry: registry(),
        policy: { workingDirectoryRoots: [root] },
      });
      expect(() =>
        factory.create({
          providerId: "codex",
          name: "escaper",
          config: { workingDirectory: join(root, "escape") },
        }),
      ).toThrow(
        expect.objectContaining({ code: "WORKFLOW_AGENT_POLICY_EXCEEDED" }),
      );
    });

    test("an allowedPath through a symlink that leaves the root is rejected", () => {
      const { root, outside } = layout();
      symlinkSync(outside, join(root, "escape"));
      const factory = new ExternalAgentWorkflowFactory({
        registry: registry(),
        policy: { workingDirectoryRoots: [root] },
      });
      for (const allowedPath of [join(root, "escape"), "escape/sub"]) {
        expect(() =>
          factory.create({
            providerId: "codex",
            name: "escaper",
            config: {
              workingDirectory: root,
              permissions: {
                mode: "workspace-write",
                allowedPaths: [allowedPath],
              },
            },
          }),
        ).toThrow(
          expect.objectContaining({ code: "WORKFLOW_AGENT_POLICY_EXCEEDED" }),
        );
      }
    });

    test("a dangling symlink to outside the root is rejected", () => {
      const { root, outside } = layout();
      symlinkSync(join(outside, "later"), join(root, "later"));
      const factory = new ExternalAgentWorkflowFactory({
        registry: registry(),
        policy: { workingDirectoryRoots: [root] },
      });
      expect(() =>
        factory.create({
          providerId: "codex",
          name: "escaper",
          config: { workingDirectory: join(root, "later") },
        }),
      ).toThrow(
        expect.objectContaining({ code: "WORKFLOW_AGENT_POLICY_EXCEEDED" }),
      );
    });

    test("a root given through a symlink still admits its own real paths", () => {
      const { root, outside } = layout();
      const alias = join(outside, "alias");
      symlinkSync(root, alias);
      mkdirSync(join(root, "work"));
      const factory = new ExternalAgentWorkflowFactory({
        registry: registry(),
        policy: { workingDirectoryRoots: [alias] },
      });
      const viaReal = factory.create({
        providerId: "codex",
        name: "real",
        config: { workingDirectory: join(root, "work") },
      });
      const viaAlias = factory.create({
        providerId: "codex",
        name: "alias",
        config: { workingDirectory: join(alias, "work") },
      });
      // The working directory the agent gets is the requested one.
      expect((viaReal.agent as ExternalAgent).workingDirectory).toBe(
        join(root, "work"),
      );
      expect((viaAlias.agent as ExternalAgent).workingDirectory).toBe(
        join(alias, "work"),
      );
    });

    test("a symlink that stays inside the root is accepted", () => {
      const { root } = layout();
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "link"));
      const factory = new ExternalAgentWorkflowFactory({
        registry: registry(),
        policy: { workingDirectoryRoots: [root] },
      });
      expect(() =>
        factory.create({
          providerId: "codex",
          name: "inside",
          config: {
            workingDirectory: join(root, "link"),
            permissions: { mode: "workspace-write", allowedPaths: ["."] },
          },
        }),
      ).not.toThrow();
    });
  },
);
