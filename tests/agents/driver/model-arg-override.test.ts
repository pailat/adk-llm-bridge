/**
 * The driver's `model` option is the only model id the bridge sends. Extra
 * `args` (Claude CLI, Codex CLI) and the Codex SDK `config` object may not
 * set, remap or route the model, even with `allowPolicyOverrideArgs`: that
 * opt-in is about the permission policy, and a model override would make the
 * reported requested model wrong.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "@google/adk";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import {
  CODEX_MODEL_CONFIG_KEYS,
  flattenCodexConfigKeys,
} from "../../../src/agents/driver/model.js";
import {
  EXTERNAL_AGENT_MODEL_INVALID,
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_MODEL_REQUIRED,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import { CODEX_PROVIDER } from "../../../src/agents/index.js";

function refusal(build: () => unknown): ExternalAgentPolicyError {
  try {
    build();
  } catch (error) {
    if (error instanceof ExternalAgentPolicyError) return error;
    throw error;
  }
  throw new Error("expected the driver to refuse");
}

const CLAUDE_MODEL_ARGS: readonly (readonly string[])[] = [
  ["--model", "x"],
  ["--model=x"],
  ["--fallback-model", "x"],
  ["--fallback-model=x"],
  // Fail closed: an entry spelled like the flag is refused even as a value.
  ["--append-system-prompt", "--model"],
];

const CODEX_MODEL_ARGS: readonly (readonly string[])[] = [
  ["--model", "x"],
  ["--model=x"],
  ["-m", "x"],
  ["-mx"],
  ["-m=x"],
  // Clap expands a cluster of boolean short flags: `-hm x` is `-h -m x`.
  ["-hm", "x"],
  ["-Vmx"],
  ["--oss"],
  ["--local-provider", "ollama"],
  ["--local-provider=lmstudio"],
  ["-p", "x"],
  ["-px"],
  ["--profile", "x"],
  ["--profile=x"],
  ["-c", 'model="x"'],
  ["--config", 'model="x"'],
  ["--config=model=x"],
  ["-cmodel=x"],
  ["-c", '"model"=x'],
  ["-c", "'model'=x"],
  ["-c", " model = x"],
  ["-c", "MODEL=x"],
  ["-c", "model_provider=oss"],
  ["-c", "model_providers.x.base_url=y"],
  ["-c", '"model_providers".x.base_url=y'],
  ["-c", "oss_provider=ollama"],
  ["-c", "openai_base_url=https://example.invalid"],
  ["-c", "chatgpt_base_url=https://example.invalid"],
  ["-c", "model_catalog_json=/tmp/catalog.json"],
  ["--config=model_catalog_url=https://example.invalid/models"],
  ["-c", "profile=x"],
  ["-c", "profiles.x.model=y"],
  ["-hc", "model=x"],
];

describe("ClaudeCliDriver: model-setting args", () => {
  for (const args of CLAUDE_MODEL_ARGS) {
    for (const allowPolicyOverrideArgs of [false, true]) {
      test(`refuses ${JSON.stringify(args)} (allowPolicyOverrideArgs: ${allowPolicyOverrideArgs})`, () => {
        const error = refusal(
          () => new ClaudeCliDriver({ args, allowPolicyOverrideArgs }),
        );
        expect(error.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
        expect(error.message).toContain("model option");
      });
    }
  }

  test("keeps args that do not touch the model", () => {
    const args = ["--verbose", "--append-system-prompt=Be brief.", "-nwork"];
    const driver = new ClaudeCliDriver({ args });
    expect(
      driver
        .buildArgs({ provider: CODEX_PROVIDER, context: {} as never })
        .slice(-args.length),
    ).toEqual(args);
  });
});

describe("CodexCliDriver: model-setting args", () => {
  for (const args of CODEX_MODEL_ARGS) {
    test(`refuses ${JSON.stringify(args)} with allowPolicyOverrideArgs`, () => {
      const error = refusal(
        () => new CodexCliDriver({ args, allowPolicyOverrideArgs: true }),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    });
    test(`refuses ${JSON.stringify(args)} without the opt-in`, () => {
      const error = refusal(() => new CodexCliDriver({ args }));
      // Profiles are also policy pins: without the opt-in the policy check
      // runs first and names its own code.
      expect([
        EXTERNAL_AGENT_MODEL_OVERRIDE,
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      ]).toContain(error.code);
    });
  }

  test("profiles are refused by the policy check first, then by the model check", () => {
    expect(refusal(() => new CodexCliDriver({ args: ["-p", "x"] })).code).toBe(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    );
    expect(
      refusal(
        () =>
          new CodexCliDriver({
            args: ["-p", "x"],
            allowPolicyOverrideArgs: true,
          }),
      ).code,
    ).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
  });

  test("keeps model_reasoning_effort and other model-free args", () => {
    const args = [
      "-c",
      'model_reasoning_effort="high"',
      "--config=model_reasoning_summary=auto",
      "-c",
      "models_extra=1",
      "--skip-git-repo-check",
      "-ishot.png",
    ];
    const argv = new CodexCliDriver({ args }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
    });
    expect(argv.slice(-(args.length + 2), -2)).toEqual(args);
  });

  test("the model flag comes before the user args", () => {
    const argv = new CodexCliDriver({
      model: "gpt-x",
      args: ["--skip-git-repo-check"],
    }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
      permissions: { mode: "workspace-write" },
    });
    expect(argv.indexOf("--model=gpt-x")).toBeGreaterThan(-1);
    expect(argv.indexOf("--model=gpt-x")).toBeLessThan(
      argv.indexOf("--skip-git-repo-check"),
    );
    expect(argv.indexOf("--model=gpt-x")).toBeGreaterThan(
      argv.indexOf("--sandbox"),
    );
  });
});

describe("CodexSdkDriver: model-setting config", () => {
  const CONFIGS: readonly Record<string, unknown>[] = [
    { model: "x" },
    { model_provider: "oss" },
    { model_providers: { x: { base_url: "y" } } },
    { "model_providers.x": {} },
    { oss_provider: "ollama" },
    { openai_base_url: "https://example.invalid" },
    { chatgpt_base_url: "https://example.invalid" },
    { model_catalog_json: "/tmp/catalog.json" },
    { model_catalog_url: "https://example.invalid/models" },
    { profile: "x" },
    { profiles: { x: { model: "y" } } },
    { profiles: {} },
    { '"model"': "x" },
    { "'model'": "x" },
    { " model": "x" },
    { MODEL: "x" },
    { mcp_servers: { a: { enabled: false } }, model: "x" },
  ];

  for (const config of CONFIGS) {
    test(`refuses config ${JSON.stringify(config)}`, () => {
      const error = refusal(
        () => new CodexSdkDriver({ config: config as never }),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    });
  }

  test("keeps config without model keys", () => {
    const driver = new CodexSdkDriver({
      config: {
        model_reasoning_effort: "high",
        mcp_servers: { docs: { command: "docs-mcp" } },
        models_extra: 1,
      },
    });
    expect(driver.model).toBeUndefined();
  });

  test("the model key list matches the Codex CLI table", () => {
    expect([...CODEX_MODEL_CONFIG_KEYS].sort()).toEqual(
      [
        "model",
        "model_provider",
        "model_providers",
        "oss_provider",
        "openai_base_url",
        "chatgpt_base_url",
        "model_catalog_json",
        "model_catalog_url",
        "profile",
        "profiles",
      ].sort(),
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "flattenCodexConfigKeys matches what @openai/codex-sdk sends",
  () => {
    test("each --config key the SDK emits is a key the driver checks", async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-flatten-"));
      try {
        const argvFile = join(dir, "argv.txt");
        const fake = join(dir, "codex");
        // A literal script. Like the real CLI it reads the prompt from stdin
        // to the end before it exits: a stub that exits first makes the SDK's
        // write of the prompt fail with EPIPE, and the SDK has no error
        // handler on that stream. The argv file comes from the environment.
        writeFileSync(
          fake,
          '#!/bin/sh\ncat > /dev/null\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done > "$ARGV_FILE"\n',
        );
        chmodSync(fake, 0o755);
        const config = {
          a: 1,
          nested: { deep: { key: "v" }, list: [1, 2] },
          empty: {},
          "dotted.key": true,
          '"quoted"': "q",
          "with space": "s",
        };
        const { Codex } = (await import("@openai/codex-sdk")) as unknown as {
          Codex: new (
            options: unknown,
          ) => {
            startThread(): { run(input: string): Promise<unknown> };
          };
        };
        const codex = new Codex({
          codexPathOverride: fake,
          config,
          env: { PATH: "/usr/bin:/bin", ARGV_FILE: argvFile },
        });
        await codex
          .startThread()
          .run("hi")
          .catch(() => undefined);
        const argv = readFileSync(argvFile, "utf8").split("\n");
        const emitted: string[] = [];
        for (let index = 0; index < argv.length; index++) {
          if (argv[index] === "--config") {
            emitted.push(argv[index + 1] ?? "");
          }
        }
        // The SDK sends `path=value` with the path as built: compare the
        // paths themselves, before any normalization.
        const keyOf = (override: string) => override.split("=", 1)[0] ?? "";
        expect(emitted.length).toBe(7);
        expect(flattenCodexConfigKeys(config)).toEqual(emitted.map(keyOf));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe("order of the constructor checks", () => {
  test("Claude CLI: args type, policy pin, model table, grammar, alias", () => {
    expect(
      () =>
        new ClaudeCliDriver({
          args: [1] as unknown as string[],
          model: "-bad",
        }),
    ).toThrow(InputValidationError);

    const all = {
      args: ["--permission-mode", "bypassPermissions", "--model", "x"],
      model: "-bad",
      requireExplicitModel: true,
    };
    expect(refusal(() => new ClaudeCliDriver(all)).code).toBe(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    );
    expect(
      refusal(() => new ClaudeCliDriver({ ...all, args: ["--model", "x"] }))
        .code,
    ).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    expect(
      refusal(
        () =>
          new ClaudeCliDriver({
            ...all,
            args: ["--permission-mode", "bypassPermissions", "--model", "x"],
            allowPolicyOverrideArgs: true,
          }),
      ).code,
    ).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    expect(refusal(() => new ClaudeCliDriver({ ...all, args: [] })).code).toBe(
      EXTERNAL_AGENT_MODEL_INVALID,
    );
    expect(
      refusal(() => new ClaudeCliDriver({ ...all, args: [], model: "default" }))
        .code,
    ).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
    expect(
      new ClaudeCliDriver({ ...all, args: [], model: "claude-opus-5-5" }).model,
    ).toBe("claude-opus-5-5");
  });

  test("Codex SDK: config check before grammar before required", () => {
    expect(
      refusal(
        () =>
          new CodexSdkDriver({
            config: { model: "x" },
            model: "-bad",
            requireExplicitModel: true,
          }),
      ).code,
    ).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    expect(
      refusal(
        () => new CodexSdkDriver({ model: "-bad", requireExplicitModel: true }),
      ).code,
    ).toBe(EXTERNAL_AGENT_MODEL_INVALID);
    expect(
      refusal(() => new CodexSdkDriver({ requireExplicitModel: true })).code,
    ).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
  });
});
