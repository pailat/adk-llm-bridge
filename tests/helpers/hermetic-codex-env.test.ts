/**
 * `withHermeticCodexEnv` must hide the developer machine's Codex setup: a
 * signed-in `auth.json`, a `codex` binary on PATH and Codex credential
 * variables. Each test plants such a machine in `process.env` first.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { HERMETIC_CODEX_ENV_KEYS, withHermeticCodexEnv } from "./env.js";
import { resolveBridgeToSource } from "./example-modules.js";

resolveBridgeToSource();
const CODEX_EXAMPLE = "../../examples/basic-agent-codex/agent.ts";

const MACHINE_KEYS = ["HOME", "PATH", ...HERMETIC_CODEX_ENV_KEYS] as const;

/** Runs `fn` with a fake signed-in Codex machine in `process.env`. */
async function onCodexMachine(
  fn: (machine: { home: string; bin: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "acme-codex-machine-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"x"}');
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);

  const saved = Object.fromEntries(
    MACHINE_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.HOME = home;
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
  for (const key of HERMETIC_CODEX_ENV_KEYS) delete process.env[key];
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.CODEX_API_KEY = "acme-codex-key";
  process.env.OPENAI_API_KEY = "acme-openai-key";
  process.env.CODEX_EXECUTABLE = join(bin, "codex");
  try {
    await fn({ home, bin });
  } finally {
    for (const key of MACHINE_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe("withHermeticCodexEnv", () => {
  test("hides the machine's HOME, CODEX_HOME, PATH binary and Codex variables", async () => {
    await onCodexMachine(async (machine) => {
      await withHermeticCodexEnv(({ home, codexHome, bin }) => {
        expect(process.env.HOME).toBe(home);
        expect(home).not.toBe(machine.home);
        expect(readdirSync(home)).toEqual([]);
        expect(process.env.CODEX_HOME).toBe(codexHome);
        expect(readdirSync(codexHome)).toEqual([]);
        expect(process.env.PATH).toBe(bin);
        expect(readdirSync(bin)).toEqual([]);
        for (const key of HERMETIC_CODEX_ENV_KEYS) {
          if (key !== "CODEX_HOME") expect(process.env[key]).toBeUndefined();
        }
      });
    });
  });

  test("the basic-agent-codex guard sees no credential on a signed-in machine", async () => {
    const { codexCredentialsAvailable } = (await import(CODEX_EXAMPLE)) as {
      codexCredentialsAvailable(): boolean;
    };
    await onCodexMachine(async () => {
      expect(codexCredentialsAvailable()).toBe(true);
      await withHermeticCodexEnv(() => {
        expect(codexCredentialsAvailable()).toBe(false);
      });
    });
  });

  test("restores the environment and removes its directories afterwards", async () => {
    await onCodexMachine(async () => {
      const before = Object.fromEntries(
        MACHINE_KEYS.map((key) => [key, process.env[key]]),
      );
      let root = "";
      await withHermeticCodexEnv(async ({ home }) => {
        root = join(home, "..");
        process.env.CODEX_API_KEY = "set-inside";
      });
      expect(
        Object.fromEntries(MACHINE_KEYS.map((key) => [key, process.env[key]])),
      ).toEqual(before);
      expect(existsSync(root)).toBe(false);
    });
  });

  test("restores the environment when the body throws", async () => {
    await onCodexMachine(async (machine) => {
      await expect(
        withHermeticCodexEnv(() => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(process.env.HOME).toBe(machine.home);
      expect(process.env.CODEX_API_KEY).toBe("acme-codex-key");
    });
  });
});
