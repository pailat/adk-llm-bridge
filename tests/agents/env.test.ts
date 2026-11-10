import { describe, expect, test } from "bun:test";
import {
  buildChildEnv,
  credentialEnv,
} from "../../src/agents/driver/shared.js";
import {
  EnvCredentialProvider,
  readAllowedEnv,
} from "../../src/agents/index.js";

describe("environment credential allowlist", () => {
  test("reads only allowlisted non-empty variables", () => {
    const env = {
      OPENAI_API_KEY: "allowed",
      SECRET_TOKEN: "blocked",
      EMPTY: "",
    };

    expect(readAllowedEnv(env, ["OPENAI_API_KEY", "EMPTY", "MISSING"])).toEqual(
      {
        OPENAI_API_KEY: "allowed",
      },
    );
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
      provider.getCredential({
        providerId: "codex",
        envAllowlist: ["OPENAI_API_KEY"],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("driver child environment", () => {
  const provider = {
    id: "p",
    name: "P",
    command: "p",
    envAllowlist: ["API_KEY", "HOME"],
  };

  test("keeps only base keys and allowlisted credential values", () => {
    const env = buildChildEnv(
      { PATH: "/bin", HOME: "/h", SECRET: "host-secret", EMPTY: "" },
      ["PATH", "HOME", "EMPTY", "MISSING"],
      {
        provider,
        context: {} as never,
        credential: {
          kind: "env",
          env: { API_KEY: "k", HOME: "/credential-home", OTHER: "x" },
        },
      },
    );

    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/credential-home",
      API_KEY: "k",
    });
  });

  test("ignores credentials that are not of kind env", () => {
    expect(
      credentialEnv({
        provider,
        context: {} as never,
        credential: { kind: "none" } as never,
      }),
    ).toEqual({});
    expect(credentialEnv({ provider, context: {} as never })).toEqual({});
  });
});
