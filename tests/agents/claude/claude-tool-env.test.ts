import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { InputValidationError } from "@google/adk";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliDriverConfig,
  type ClaudeCliSpawnOptions,
} from "../../../src/agents/driver/claude-cli.js";
import {
  CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH,
  type ClaudeToolEnv,
} from "../../../src/agents/driver/claude-tool-env.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import {
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { RunSpecV1Schema } from "../../../src/workflows/spec/schema.js";

const REQUEST = {
  provider: CLAUDE_PROVIDER,
  context: {} as never,
  instruction: "Open the Acme pull request.",
};

/** A host environment with tool, proxy and unrelated secret variables. */
const HOST: Record<string, string | undefined> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/acme",
  USER: "acme",
  SHELL: "/bin/bash",
  CLAUDE_CONFIG_DIR: "/home/acme/.claude",
  XDG_CONFIG_HOME: "/home/acme/.config",
  GH_TOKEN: "gh-acme-token",
  GIT_ASKPASS: "/usr/local/bin/acme-askpass",
  EMPTY_ONE: "",
  HTTPS_PROXY: "http://proxy.acme.test:3128",
  https_proxy: "http://proxy.acme.test:3128",
  HTTP_PROXY: "http://proxy.acme.test:3128",
  http_proxy: "http://proxy.acme.test:3128",
  NO_PROXY: "localhost",
  no_proxy: "localhost",
  SSL_CERT_FILE: "/etc/acme/ca.pem",
  SSL_CERT_DIR: "/etc/acme/certs",
  NODE_EXTRA_CA_CERTS: "/etc/acme/extra.pem",
  ACME_DB_PASSWORD: "never-copied",
};

type ToolEnvOption = ClaudeToolEnv | undefined;

function sdk(
  toolEnv?: unknown,
  env: Record<string, string | undefined> = HOST,
) {
  return new ClaudeAgentSdkDriver({
    env,
    pathToClaudeCodeExecutable: "/fake/claude",
    ...(toolEnv === undefined
      ? {}
      : { toolEnv: toolEnv as ClaudeAgentSdkDriverConfig["toolEnv"] }),
    sdk: { query: () => (async function* () {})() as never },
  });
}

function cli(
  toolEnv?: unknown,
  env: Record<string, string | undefined> = HOST,
  onSpawn?: (options: ClaudeCliSpawnOptions) => void,
) {
  return new ClaudeCliDriver({
    env,
    ...(toolEnv === undefined
      ? {}
      : { toolEnv: toolEnv as ClaudeCliDriverConfig["toolEnv"] }),
    spawn: (_command, _args, options) => {
      onSpawn?.(options);
      return {
        stdout: [
          `${JSON.stringify({ type: "system", subtype: "init", model: "claude-test" })}\n`,
          `${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s-1" })}\n`,
        ],
        stderr: [],
        exited: Promise.resolve(0),
      };
    },
  });
}

const BUILDERS = [
  ["ClaudeAgentSdkDriver", sdk],
  ["ClaudeCliDriver", cli],
] as const;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("toolEnv is off by default", () => {
  test("the SDK driver env is unchanged byte for byte", () => {
    const env = sdk().buildEnv(REQUEST);
    expect(JSON.stringify(env)).toBe(
      JSON.stringify({
        PATH: "/usr/bin:/bin",
        HOME: "/home/acme",
        USER: "acme",
        SHELL: "/bin/bash",
        CLAUDE_CONFIG_DIR: "/home/acme/.claude",
        XDG_CONFIG_HOME: "/home/acme/.config",
        CLAUDE_AGENT_SDK_CLIENT_APP: "adk-llm-bridge",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      }),
    );
  });

  test("the CLI driver env is unchanged byte for byte", () => {
    const env = cli().buildEnv(REQUEST);
    expect(JSON.stringify(env)).toBe(
      JSON.stringify({
        PATH: "/usr/bin:/bin",
        HOME: "/home/acme",
        USER: "acme",
        SHELL: "/bin/bash",
        CLAUDE_CONFIG_DIR: "/home/acme/.claude",
        XDG_CONFIG_HOME: "/home/acme/.config",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      }),
    );
  });

  for (const [name, build] of BUILDERS) {
    test(`${name}: an explicit undefined toolEnv is the same as none`, () => {
      expect(
        JSON.stringify(build({ toolEnv: undefined }.toolEnv).buildEnv(REQUEST)),
      ).toBe(JSON.stringify(build().buildEnv(REQUEST)));
    });
  }
});

describe("toolEnv copies the listed names", () => {
  for (const [name, build] of BUILDERS) {
    test(`${name}: set, non-empty names only, from the driver env`, () => {
      const env = build({
        names: ["GH_TOKEN", "GIT_ASKPASS", "EMPTY_ONE", "UNSET_ONE"],
      }).buildEnv(REQUEST);
      expect(env.GH_TOKEN).toBe("gh-acme-token");
      expect(env.GIT_ASKPASS).toBe("/usr/local/bin/acme-askpass");
      expect(env).not.toHaveProperty("EMPTY_ONE");
      expect(env).not.toHaveProperty("UNSET_ONE");
      expect(env).not.toHaveProperty("ACME_DB_PASSWORD");
      expect(env).not.toHaveProperty("HTTPS_PROXY");
      expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    });

    test(`${name}: a source record wins over the driver env`, () => {
      const env = build({
        names: ["GH_TOKEN"],
        source: { GH_TOKEN: "gh-acme-from-source", ACME_DB_PASSWORD: "x" },
      }).buildEnv(REQUEST);
      expect(env.GH_TOKEN).toBe("gh-acme-from-source");
      expect(env).not.toHaveProperty("ACME_DB_PASSWORD");
    });

    test(`${name}: a source function is read each time the env is built`, () => {
      let token = "gh-acme-1";
      const driver = build({
        names: ["GH_TOKEN"],
        source: () => ({ GH_TOKEN: token }),
      });
      expect(driver.buildEnv(REQUEST).GH_TOKEN).toBe("gh-acme-1");
      token = "gh-acme-2";
      expect(driver.buildEnv(REQUEST).GH_TOKEN).toBe("gh-acme-2");
    });

    test(`${name}: a credential variable of the same name wins`, () => {
      const request = {
        ...REQUEST,
        provider: {
          ...CLAUDE_PROVIDER,
          envAllowlist: [...(CLAUDE_PROVIDER.envAllowlist ?? []), "GH_TOKEN"],
        },
        credential: { kind: "env" as const, env: { GH_TOKEN: "from-cred" } },
      };
      expect(build({ names: ["GH_TOKEN"] }).buildEnv(request).GH_TOKEN).toBe(
        "from-cred",
      );
    });

    test(`${name}: proxyPassthrough copies the proxy and CA variables`, () => {
      const env = build({ proxyPassthrough: true }).buildEnv(REQUEST);
      for (const key of CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH) {
        expect(env[key]).toBe(HOST[key] as string);
      }
      expect(env).not.toHaveProperty("GH_TOKEN");
      expect(env).not.toHaveProperty("ACME_DB_PASSWORD");
    });

    test(`${name}: proxyPassthrough reads the driver env when a source is set`, () => {
      const env = build({
        names: ["GH_TOKEN"],
        source: () => ({ GH_TOKEN: "gh-acme-from-source" }),
        proxyPassthrough: true,
      }).buildEnv(REQUEST);
      expect(env.GH_TOKEN).toBe("gh-acme-from-source");
      for (const key of CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH) {
        expect(env[key]).toBe(HOST[key] as string);
      }
    });

    test(`${name}: a non-empty source proxy value wins over the driver env`, () => {
      const env = build({
        source: {
          HTTPS_PROXY: "http://run-proxy.acme.test:8080",
          NO_PROXY: "",
        },
        proxyPassthrough: true,
      }).buildEnv(REQUEST);
      expect(env.HTTPS_PROXY).toBe("http://run-proxy.acme.test:8080");
      expect(env.NO_PROXY).toBe("localhost");
    });

    test(`${name}: names alone do not pass the proxy variables`, () => {
      const env = build({ names: ["GH_TOKEN"] }).buildEnv(REQUEST);
      for (const key of CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH) {
        expect(env).not.toHaveProperty(key);
      }
    });
  }

  test("the proxy list matches Codex, plus NODE_EXTRA_CA_CERTS", () => {
    expect([...CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH]).toEqual([
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
    ]);
  });

  test("the CLI child process receives the variables", async () => {
    let env: Record<string, string | undefined> | undefined;
    const driver = cli({ names: ["GH_TOKEN"] }, HOST, (options) => {
      env = options.env;
    });
    const events: ExternalAgentEvent[] = [];
    for await (const event of driver.run(REQUEST)) events.push(event);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(env?.GH_TOKEN).toBe("gh-acme-token");
  });

  test("an SDK run reads a source function once and delivers that value", async () => {
    // allowedPaths and a declared MCP server make the run build the env for
    // the model check, the MCP secret check, the options and the session
    // reads: a source that mints a token per call must still mint one.
    const work = realpathSync.native(
      mkdtempSync(join(import.meta.dir, ".tool-env-scratch-")),
    );
    try {
      let calls = 0;
      let delivered: Record<string, string | undefined> | undefined;
      const driver = new ClaudeAgentSdkDriver({
        env: HOST,
        pathToClaudeCodeExecutable: "/fake/claude",
        toolEnv: {
          names: ["GH_TOKEN"],
          source: () => {
            calls += 1;
            return { GH_TOKEN: `gh-acme-mint-${calls}` };
          },
        },
        mcpServers: {
          acme_tools: {
            type: "stdio",
            command: "/bin/sh",
            args: ["-v"],
            env: { MODE: { public: "fast" } },
          },
        },
        sdk: {
          query: ((input: { options?: { env?: typeof delivered } }) => {
            delivered = input.options?.env;
            return (async function* () {})();
          }) as never,
        },
      });
      const request = {
        ...REQUEST,
        workingDirectory: work,
        permissions: {
          mode: "workspace-write" as const,
          allowedPaths: [work],
        },
      };
      for await (const _event of driver.run(request)) {
        // Drain the run.
      }
      expect(delivered?.GH_TOKEN).toBe("gh-acme-mint-1");
      expect(calls).toBe(1);
      // A later run reads the source again.
      for await (const _event of driver.run(request)) {
        // Drain the run.
      }
      expect(delivered?.GH_TOKEN).toBe("gh-acme-mint-2");
      expect(calls).toBe(2);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("two interleaved SDK runs of one request keep their own token", async () => {
    const work = realpathSync.native(
      mkdtempSync(join(import.meta.dir, ".tool-env-scratch-")),
    );
    try {
      let calls = 0;
      const delivered: (string | undefined)[] = [];
      const driver = new ClaudeAgentSdkDriver({
        env: HOST,
        pathToClaudeCodeExecutable: "/fake/claude",
        toolEnv: {
          names: ["GH_TOKEN"],
          source: () => {
            calls += 1;
            return { GH_TOKEN: `gh-acme-mint-${calls}` };
          },
        },
        sdk: {
          query: ((input: {
            options?: { env?: Record<string, string | undefined> };
          }) => {
            delivered.push(input.options?.env?.GH_TOKEN);
            return (async function* () {})();
          }) as never,
        },
      });
      const request = {
        ...REQUEST,
        workingDirectory: work,
        permissions: {
          mode: "workspace-write" as const,
          allowedPaths: [work],
        },
      };
      const drain = async () => {
        for await (const _event of driver.run(request)) {
          // Drain the run.
        }
      };
      await Promise.all([drain(), drain()]);
      expect(calls).toBe(2);
      expect([...delivered].sort()).toEqual([
        "gh-acme-mint-1",
        "gh-acme-mint-2",
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("toolEnv refusals", () => {
  const grammar = RunSpecV1Schema.shape.env.element;

  for (const [name, build] of BUILDERS) {
    for (const bad of [
      "1GH",
      "GH-TOKEN",
      "GH TOKEN",
      "",
      "A".repeat(129),
      "É",
    ]) {
      test(`${name}: refuses ${JSON.stringify(bad.slice(0, 12))} by the run-spec grammar`, () => {
        // The same names the run-spec env grammar refuses.
        expect(grammar.safeParse(bad).success).toBe(false);
        const error = thrown(() => build({ names: [bad] }));
        expect(error).toBeInstanceOf(InputValidationError);
        expect((error as Error).message).toContain("toolEnv");
      });
    }

    test(`${name}: accepts the longest grammar name`, () => {
      const longest = `A${"_".repeat(127)}`;
      expect(grammar.safeParse(longest).success).toBe(true);
      expect(() => build({ names: [longest] })).not.toThrow();
    });

    for (const model of [
      "ANTHROPIC_MODEL",
      "anthropic_default_sonnet_model",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "MY_MODEL_ROUTE",
      "CLAUDE_CODE_CLIENT_DATA_URL",
      "CLAUDE_CODE_3P_ROUTE",
    ]) {
      test(`${name}: refuses the model name ${model}`, () => {
        const error = thrown(() => build({ names: [model] }));
        expect(error).toBeInstanceOf(ExternalAgentPolicyError);
        expect((error as ExternalAgentPolicyError).code).toBe(
          EXTERNAL_AGENT_MODEL_OVERRIDE,
        );
        expect((error as Error).message).toContain(model);
        expect((error as Error).message).toContain("would change the model");
      });
    }

    for (const debug of [
      "DEBUG",
      "debug",
      "ANTHROPIC_LOG",
      "CLAUDE_DEBUG",
      "CLAUDE_CODE_DEBUG_LOGS",
    ]) {
      test(`${name}: refuses the debug switch ${debug}`, () => {
        const error = thrown(() => build({ names: [debug] }));
        expect(error).toBeInstanceOf(ExternalAgentPolicyError);
        expect((error as ExternalAgentPolicyError).code).toBe(
          EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        );
        expect((error as Error).message).toContain("debug switch");
      });
    }

    for (const reserved of [
      "PATH",
      "home",
      "USER",
      "SHELL",
      "XDG_CONFIG_HOME",
      "TMPDIR",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_TMPDIR",
      "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
      "CLAUDE_AGENT_SDK_CLIENT_APP",
      "CLAUDE_CODE_USE_BEDROCK",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ENABLE_MCP_LARGE_OUTPUT_FILES",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      test(`${name}: refuses the runtime name ${reserved}`, () => {
        const error = thrown(() => build({ names: [reserved] }));
        expect(error).toBeInstanceOf(ExternalAgentPolicyError);
        expect((error as ExternalAgentPolicyError).code).toBe(
          EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        );
        expect((error as Error).message).toContain(reserved);
      });
    }

    test(`${name}: refuses a duplicate name`, () => {
      const error = thrown(() => build({ names: ["GH_TOKEN", "GH_TOKEN"] }));
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as Error).message).toContain("more than once");
    });

    for (const [label, value] of [
      ["a non-object toolEnv", "GH_TOKEN"],
      ["an array toolEnv", ["GH_TOKEN"]],
      ["non-array names", { names: "GH_TOKEN" }],
      ["a non-string name", { names: [7] }],
      ["a non-boolean proxyPassthrough", { proxyPassthrough: "yes" }],
      ["a non-object source", { names: ["GH_TOKEN"], source: "GH_TOKEN=x" }],
      ["an unknown key", { names: ["GH_TOKEN"], inherit: true }],
    ] as const) {
      test(`${name}: refuses ${label}`, () => {
        expect(thrown(() => build(value))).toBeInstanceOf(InputValidationError);
      });
    }

    test(`${name}: a value that is not a string is not copied`, () => {
      const env = build({
        names: ["GH_TOKEN"],
        source: { GH_TOKEN: 7 as unknown as string },
      }).buildEnv(REQUEST);
      expect(env).not.toHaveProperty("GH_TOKEN");
    });
  }

  test("the option type is exported", () => {
    const option: ToolEnvOption = {
      names: ["GH_TOKEN"],
      proxyPassthrough: true,
    };
    expect(option.names).toEqual(["GH_TOKEN"]);
  });
});
