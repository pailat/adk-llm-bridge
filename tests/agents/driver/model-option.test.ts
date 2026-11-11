/**
 * Every built-in driver checks its `model` option when it is built: a value
 * that is not a usable model id is refused instead of being dropped (the
 * Claude Agent SDK and Codex SDK used to drop `""` and run the default
 * model) or passed on to be read as a flag. `requireExplicitModel` refuses a
 * driver without a model, or with an alias that lets the runtime choose.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import {
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/driver/gemini-cli.js";
import {
  EXTERNAL_AGENT_MODEL_INVALID,
  EXTERNAL_AGENT_MODEL_REQUIRED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  type ExternalAgentDriver,
  type ExternalAgentRunRequest,
  GEMINI_CLI_PROVIDER,
} from "../../../src/agents/index.js";

type DriverKind =
  | "claude-sdk"
  | "claude-cli"
  | "codex-sdk"
  | "codex-cli"
  | "gemini";

const KINDS: readonly DriverKind[] = [
  "claude-sdk",
  "claude-cli",
  "codex-sdk",
  "codex-cli",
  "gemini",
];

interface ModelOptions {
  model?: unknown;
  requireExplicitModel?: boolean;
}

function build(kind: DriverKind, options: ModelOptions): ExternalAgentDriver {
  const config = options as never;
  switch (kind) {
    case "claude-sdk":
      return new ClaudeAgentSdkDriver({
        ...(config as object),
        pathToClaudeCodeExecutable: "/example/bin/claude",
      });
    case "claude-cli":
      return new ClaudeCliDriver(config);
    case "codex-sdk":
      return new CodexSdkDriver(config);
    case "codex-cli":
      return new CodexCliDriver(config);
    case "gemini":
      return new GeminiCliDriver(config);
  }
}

function request(
  provider: ExternalAgentRunRequest["provider"],
): ExternalAgentRunRequest {
  return {
    provider,
    context: { input: "hi" } as never,
    instruction: "say hi",
    permissions: { mode: "ask", allowNetwork: true },
  };
}

async function geminiArgv(driver: GeminiCliDriver): Promise<readonly string[]> {
  let argv: readonly string[] = [];
  const spawn: GeminiCliSpawn = (_command, args) => {
    argv = args;
    return { stdout: [], exited: Promise.resolve(0) };
  };
  const withSpawn = new GeminiCliDriver({
    spawn,
    model: driver.model,
    env: { PATH: "/usr/bin:/bin" },
  });
  for await (const _ of withSpawn.run(request(GEMINI_CLI_PROVIDER))) {
    // drain
  }
  return argv;
}

/** What the driver sends for its model: a CLI flag or an SDK option. */
async function sentModel(
  kind: DriverKind,
  driver: ExternalAgentDriver,
): Promise<{ flags: readonly string[]; option?: unknown; hasOption: boolean }> {
  switch (kind) {
    case "claude-sdk": {
      const options = (driver as ClaudeAgentSdkDriver).buildOptions(
        request(CLAUDE_PROVIDER),
      ) as Record<string, unknown>;
      return {
        flags: [],
        option: options.model,
        hasOption: "model" in options,
      };
    }
    case "codex-sdk": {
      const options = (driver as CodexSdkDriver).buildThreadOptions(
        request(CODEX_PROVIDER),
      ) as Record<string, unknown>;
      return {
        flags: [],
        option: options.model,
        hasOption: "model" in options,
      };
    }
    case "claude-cli": {
      const argv = (driver as ClaudeCliDriver).buildArgs(
        request(CLAUDE_PROVIDER),
      );
      return {
        flags: argv.filter((arg) => arg.startsWith("--model")),
        hasOption: false,
      };
    }
    case "codex-cli": {
      const argv = (driver as CodexCliDriver).buildArgs(
        request(CODEX_PROVIDER),
      );
      return {
        flags: argv.filter((arg) => arg.startsWith("--model")),
        hasOption: false,
      };
    }
    case "gemini": {
      const argv = await geminiArgv(driver as GeminiCliDriver);
      return {
        flags: argv.filter((arg) => arg.startsWith("--model")),
        hasOption: false,
      };
    }
  }
}

function refusal(buildDriver: () => unknown): ExternalAgentPolicyError {
  try {
    buildDriver();
  } catch (error) {
    if (error instanceof ExternalAgentPolicyError) return error;
    throw error;
  }
  throw new Error("expected the driver to refuse its model");
}

const INVALID: readonly unknown[] = [
  "",
  "  ",
  "a b",
  "-x",
  "--model",
  "a\u0007",
  "tab\tid",
  "line\nid",
  "x".repeat(257),
  5,
  null,
  ["opus"],
];

const VALID: readonly string[] = [
  "opus[1m]",
  "claude-opus-5-5",
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
  "gpt-6.1-sol",
  "x".repeat(256),
];

for (const kind of KINDS) {
  describe(`${kind}: model option`, () => {
    test("no model sends no model flag or option", async () => {
      const sent = await sentModel(kind, build(kind, {}));
      expect(sent.flags).toEqual([]);
      expect(sent.hasOption).toBe(false);
    });

    for (const value of INVALID) {
      test(`refuses ${JSON.stringify(value)?.slice(0, 40)} with EXTERNAL_AGENT_MODEL_INVALID`, () => {
        const error = refusal(() => build(kind, { model: value }));
        expect(error.code).toBe(EXTERNAL_AGENT_MODEL_INVALID);
        expect(error.recoverable).toBe(false);
      });
    }

    for (const value of VALID) {
      test(`sends ${value.slice(0, 40)} verbatim`, async () => {
        const driver = build(kind, { model: value });
        expect(driver.model).toBe(value);
        const sent = await sentModel(kind, driver);
        if (kind === "claude-sdk" || kind === "codex-sdk") {
          expect(sent.option).toBe(value);
        } else {
          // Joined to the flag, so the value can never be read as a flag.
          expect(sent.flags).toEqual([`--model=${value}`]);
        }
      });
    }

    test("requireExplicitModel without a model is EXTERNAL_AGENT_MODEL_REQUIRED", () => {
      const error = refusal(() => build(kind, { requireExplicitModel: true }));
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
    });

    test("requireExplicitModel with a model builds", () => {
      expect(
        build(kind, { model: "some-model-1", requireExplicitModel: true })
          .model,
      ).toBe("some-model-1");
    });
  });
}

describe("router and default aliases under requireExplicitModel", () => {
  const CLAUDE_ALIASES = [
    "default",
    "DEFAULT",
    "best",
    "opusplan",
    "opusplan[1m]",
    "OpusPlan",
  ];
  const GEMINI_ALIASES = ["auto", "AUTO", "auto-x", "Auto-Gemini-3"];

  for (const kind of ["claude-sdk", "claude-cli"] as const) {
    for (const alias of CLAUDE_ALIASES) {
      test(`${kind} refuses ${alias}`, () => {
        const error = refusal(() =>
          build(kind, { model: alias, requireExplicitModel: true }),
        );
        expect(error.code).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
        expect(error.message).toContain(alias);
      });
    }
    for (const plain of ["opus", "sonnet", "haiku", "fable", "opus[1m]"]) {
      test(`${kind} accepts the plain alias ${plain}`, () => {
        expect(
          build(kind, { model: plain, requireExplicitModel: true }).model,
        ).toBe(plain);
      });
    }
  }

  for (const alias of GEMINI_ALIASES) {
    test(`gemini refuses ${alias}`, () => {
      const error = refusal(() =>
        build("gemini", { model: alias, requireExplicitModel: true }),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
    });
  }

  test("gemini accepts an id that only contains auto", () => {
    expect(
      build("gemini", { model: "gemini-auto-2", requireExplicitModel: true })
        .model,
    ).toBe("gemini-auto-2");
  });

  test("the Codex drivers have no router alias", () => {
    for (const kind of ["codex-sdk", "codex-cli"] as const) {
      expect(
        build(kind, { model: "default", requireExplicitModel: true }).model,
      ).toBe("default");
    }
  });

  test('" best " is refused by the grammar first: EXTERNAL_AGENT_MODEL_INVALID', () => {
    const error = refusal(() =>
      build("claude-cli", { model: " best ", requireExplicitModel: true }),
    );
    expect(error.code).toBe(EXTERNAL_AGENT_MODEL_INVALID);
  });

  test("every alias is accepted without requireExplicitModel", () => {
    for (const alias of CLAUDE_ALIASES) {
      expect(build("claude-cli", { model: alias }).model).toBe(alias);
      expect(build("claude-sdk", { model: alias }).model).toBe(alias);
    }
    for (const alias of GEMINI_ALIASES) {
      expect(build("gemini", { model: alias }).model).toBe(alias);
    }
  });
});

describe("reportsResolvedModel", () => {
  test("only the Claude drivers report the model the runtime ran", () => {
    expect(build("claude-sdk", {}).reportsResolvedModel).toBe(true);
    expect(build("claude-cli", {}).reportsResolvedModel).toBe(true);
    expect(build("codex-sdk", {}).reportsResolvedModel).toBe(false);
    expect(build("codex-cli", {}).reportsResolvedModel).toBe(false);
    expect(build("gemini", {}).reportsResolvedModel).toBe(false);
  });
});
