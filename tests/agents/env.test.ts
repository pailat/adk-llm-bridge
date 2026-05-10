/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { EnvCredentialProvider, readAllowedEnv } from "../../src/agents/index.js";

describe("environment credential allowlist", () => {
  test("reads only allowlisted non-empty variables", () => {
    const env = {
      OPENAI_API_KEY: "allowed",
      SECRET_TOKEN: "blocked",
      EMPTY: "",
    };

    expect(readAllowedEnv(env, ["OPENAI_API_KEY", "EMPTY", "MISSING"])).toEqual({
      OPENAI_API_KEY: "allowed",
    });
  });

  test("credential provider does not read unallowlisted values", async () => {
    const provider = new EnvCredentialProvider({
      ANTHROPIC_API_KEY: "allowed",
      UNRELATED_SECRET: "blocked",
    });

    await expect(
      provider.getCredential({
        providerId: "claude",
        envAllowlist: ["ANTHROPIC_API_KEY"],
      }),
    ).resolves.toEqual({
      kind: "env",
      label: "claude:env",
      env: { ANTHROPIC_API_KEY: "allowed" },
    });
  });

  test("credential provider returns undefined when nothing is allowed", async () => {
    const provider = new EnvCredentialProvider({ SECRET_TOKEN: "blocked" });

    await expect(
      provider.getCredential({ providerId: "codex", envAllowlist: ["OPENAI_API_KEY"] }),
    ).resolves.toBeUndefined();
  });
});
