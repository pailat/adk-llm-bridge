import { describe, expect, test } from "bun:test";
import {
  FX_CLI_FIXED_FLAGS,
  FX_CLI_PINNED_FLAGS,
  FX_CLI_PINNED_FLAGS_REVIEW,
  FxCliDriver,
  mapFxPermission,
} from "../../../src/agents/driver/fx-cli.js";
import {
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import {
  FX_ENV_ALLOWLIST,
  FX_PROVIDER,
} from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  collect,
  errorsOf,
  FX_ASK_NETWORK_ON,
  FX_MODEL_ID,
  forbiddenSpawn,
  makeRequest,
  recordingSpawn,
  refusalCode,
} from "./helpers.js";

const request = (overrides: Parameters<typeof makeRequest>[1] = {}) =>
  makeRequest(FX_PROVIDER, overrides);

const BASE_ARGV = [
  "ask",
  "--json",
  "--no-save",
  "--no-color",
  "--model",
  FX_MODEL_ID,
];

describe("fx provider", () => {
  test("declares the fx binary and the confirmed auth variable", () => {
    expect(FX_PROVIDER).toEqual({
      id: "fx",
      name: "fx",
      command: "fx",
      envAllowlist: FX_ENV_ALLOWLIST,
    });
    expect(FX_ENV_ALLOWLIST).toEqual([
      "AI_GATEWAY_API_KEY",
      "VERCEL_OIDC_TOKEN",
    ]);
  });

  test("the driver can be built without side effects and names its provider", () => {
    const driver = new FxCliDriver(baseConfig());
    expect(driver.providerId).toBe("fx");
    expect(driver.command).toBe("fx");
    expect(driver.model).toBe(FX_MODEL_ID);
  });
});

describe("FxCliDriver buildArgs", () => {
  test("builds the exact ask argv, with no prompt in it", () => {
    const driver = new FxCliDriver(baseConfig());
    expect(driver.buildArgs(request())).toEqual(BASE_ARGV);
  });

  test("adds --effort after --model when set", () => {
    const driver = new FxCliDriver(baseConfig({ effort: "high" }));
    expect(driver.buildArgs(request())).toEqual([
      ...BASE_ARGV,
      "--effort",
      "high",
    ]);
  });

  for (const effort of ["", "--high", "very high", "hi\nlow"]) {
    test(`a bad effort ${JSON.stringify(effort)} is refused as an unsupported option`, async () => {
      const error = await refusalCode(
        () => new FxCliDriver(baseConfig({ effort })),
        request(),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
      expect(error.message).toContain("effort");
    });
  }

  test("puts --add-dir pairs before ask with allowUnenforcedPaths", () => {
    const driver = new FxCliDriver(baseConfig({ allowUnenforcedPaths: true }));
    const args = driver.buildArgs(
      request({
        permissions: { ...FX_ASK_NETWORK_ON, allowedPaths: ["/repo", "/tmp"] },
      }),
    );
    expect(args).toEqual([
      "--add-dir",
      "/repo",
      "--add-dir",
      "/tmp",
      ...BASE_ARGV,
    ]);
    expect(args.indexOf("--add-dir")).toBeLessThan(args.indexOf("ask"));
  });

  test("user args come last, after the policy flags", () => {
    const driver = new FxCliDriver(
      baseConfig({
        args: ["--debug", "--system", "x"],
        allowPolicyOverrideArgs: true,
        allowUnsandboxedShell: true,
      }),
    );
    const args = driver.buildArgs(
      request({ permissions: { mode: "workspace-write", allowNetwork: true } }),
    );
    expect(args).toEqual([...BASE_ARGV, "--auto", "--debug", "--system", "x"]);
  });
});

describe("FxCliDriver buildEnv", () => {
  test("sets the permission mode, pins auto-upgrade off and disables color", () => {
    const driver = new FxCliDriver(
      baseConfig({
        env: { PATH: "/bin", HOME: "/home/test", SECRET_TOKEN: "blocked" },
      }),
    );
    const env = driver.buildEnv(
      request({
        credential: {
          kind: "env",
          env: {
            AI_GATEWAY_API_KEY: "gw-key",
            VERCEL_OIDC_TOKEN: "oidc",
            OTHER_SECRET: "blocked",
          },
        },
      }),
    );
    expect(env.FX_PERMISSION_MODE).toBe("ask");
    expect(env.FX_AUTO_UPGRADE).toBe("0");
    expect(env.NO_COLOR).toBe("1");
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.AI_GATEWAY_API_KEY).toBe("gw-key");
    expect(env.VERCEL_OIDC_TOKEN).toBe("oidc");
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.OTHER_SECRET).toBeUndefined();
  });

  test("the child env reaches spawn with the permission mode", async () => {
    const fake = recordingSpawn();
    await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.command).toBe("fx");
    expect(fake.calls[0]?.options.env).toMatchObject({
      FX_PERMISSION_MODE: "ask",
      FX_AUTO_UPGRADE: "0",
      NO_COLOR: "1",
    });
  });
});

describe("host env never reaches the child", () => {
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/test",
    FX_PERMISSION_MODE: "full-access",
    FX_MODEL: "x/y",
    FX_HOME: "/tmp/h",
    FX_PROVIDER: "z",
  };

  test("FX_PERMISSION_MODE is the last key buildEnv writes", () => {
    const env = new FxCliDriver(baseConfig({ env: hostEnv })).buildEnv(
      request(),
    );
    expect(Object.keys(env).at(-1)).toBe("FX_PERMISSION_MODE");
    expect(env.FX_PERMISSION_MODE).toBe("ask");

    // A credential env cannot carry these variables either.
    const fromCredential = new FxCliDriver(baseConfig()).buildEnv(
      request({
        credential: {
          kind: "env",
          env: {
            AI_GATEWAY_API_KEY: "gw-key",
            FX_PERMISSION_MODE: "full-access",
            FX_MODEL: "x/y",
            FX_HOME: "/tmp/h",
            FX_PROVIDER: "z",
          },
        },
      }),
    );
    expect(fromCredential.AI_GATEWAY_API_KEY).toBe("gw-key");
    expect(fromCredential.FX_PERMISSION_MODE).toBe("ask");
    expect(Object.keys(fromCredential).at(-1)).toBe("FX_PERMISSION_MODE");
    for (const name of ["FX_MODEL", "FX_HOME", "FX_PROVIDER"]) {
      expect(fromCredential[name]).toBeUndefined();
    }
  });

  const modes: Array<[ExternalAgentPermissionPolicy, string]> = [
    [{ mode: "ask", allowNetwork: true }, "ask"],
    [{ mode: "workspace-write", allowNetwork: true }, "auto"],
    [{ mode: "full-access", allowNetwork: true }, "full-access"],
  ];
  for (const [permissions, expected] of modes) {
    test(`a host FX_PERMISSION_MODE, FX_MODEL, FX_HOME and FX_PROVIDER are not copied (${permissions.mode} runs as ${expected})`, async () => {
      for (const hostMode of ["full-access", "ask", "auto"]) {
        const fake = recordingSpawn();
        const events = await collect(
          new FxCliDriver(
            baseConfig({
              spawn: fake.spawn,
              allowUnsandboxedShell: true,
              env: { ...hostEnv, FX_PERMISSION_MODE: hostMode },
            }),
          ).run(request({ permissions })),
        );
        // The variables never reach the child, so the run is not refused.
        expect(errorsOf(events)).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
        expect(fake.calls).toHaveLength(1);
        const env = fake.calls[0]?.options.env ?? {};
        expect(env.FX_PERMISSION_MODE).toBe(expected);
        expect(env.FX_MODEL).toBeUndefined();
        expect(env.FX_HOME).toBeUndefined();
        expect(env.FX_PROVIDER).toBeUndefined();
        expect(env.FX_AUTO_UPGRADE).toBe("0");
        expect(Object.keys(env).at(-1)).toBe("FX_PERMISSION_MODE");
      }
    });
  }
});

describe("mode mapping", () => {
  test("mapFxPermission maps ask and an unset policy to env ask with no flag", () => {
    expect(mapFxPermission({ mode: "ask", allowNetwork: true })).toEqual({
      args: [],
      env: { FX_PERMISSION_MODE: "ask" },
    });
    expect(mapFxPermission(undefined)).toEqual({
      args: [],
      env: { FX_PERMISSION_MODE: "ask" },
    });
  });

  test("an unknown mode fails closed to ask", () => {
    expect(
      mapFxPermission({ mode: "bogus", allowNetwork: true } as never),
    ).toEqual({ args: [], env: { FX_PERMISSION_MODE: "ask" } });
  });

  test("full-access maps to --full-access with the matching env", () => {
    expect(
      mapFxPermission({ mode: "full-access", allowNetwork: true }),
    ).toEqual({
      args: ["--full-access"],
      env: { FX_PERMISSION_MODE: "full-access" },
    });
  });

  test("read-only is refused, naming the mode", () => {
    let error: { code?: string; message: string } | undefined;
    try {
      mapFxPermission({ mode: "read-only", allowNetwork: true });
    } catch (caught) {
      error = caught as { code?: string; message: string };
    }
    expect(error?.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
    expect(error?.message).toContain("read-only");
  });

  test("workspace-write with allowUnsandboxedShell runs as --auto", async () => {
    const fake = recordingSpawn();
    await collect(
      new FxCliDriver(
        baseConfig({ spawn: fake.spawn, allowUnsandboxedShell: true }),
      ).run(
        request({
          permissions: { mode: "workspace-write", allowNetwork: true },
        }),
      ),
    );
    expect(fake.calls[0]?.args).toEqual([...BASE_ARGV, "--auto"]);
    expect(fake.calls[0]?.options.env?.FX_PERMISSION_MODE).toBe("auto");
  });

  test("full-access with allowNetwork runs as --full-access", async () => {
    const fake = recordingSpawn();
    await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        request({ permissions: { mode: "full-access", allowNetwork: true } }),
      ),
    );
    expect(fake.calls[0]?.args).toEqual([...BASE_ARGV, "--full-access"]);
    expect(fake.calls[0]?.options.env?.FX_PERMISSION_MODE).toBe("full-access");
  });

  test("full-access without allowNetwork runs with allowUnenforcedNetwork", async () => {
    const fake = recordingSpawn();
    await collect(
      new FxCliDriver(
        baseConfig({ spawn: fake.spawn, allowUnenforcedNetwork: true }),
      ).run(request({ permissions: { mode: "full-access" } })),
    );
    expect(fake.calls[0]?.args).toContain("--full-access");
  });
});

describe("--full-access is only for the full-access mode", () => {
  const everyOptIn = baseConfig({
    allowUnenforcedNetwork: true,
    allowUnenforcedPaths: true,
    allowUnsandboxedShell: true,
    inheritHostConfig: true,
  });
  const policies: ExternalAgentPermissionPolicy[] = [
    { mode: "ask" },
    { mode: "ask", allowNetwork: true, allowedPaths: ["/repo"] },
    { mode: "workspace-write" },
    { mode: "workspace-write", allowNetwork: true, allowedPaths: ["/repo"] },
    { mode: "bogus" } as never,
  ];
  for (const permissions of policies) {
    test(`never added for ${JSON.stringify(permissions)}`, async () => {
      const fake = recordingSpawn();
      const events = await collect(
        new FxCliDriver({ ...everyOptIn, spawn: fake.spawn }).run(
          request({ permissions }),
        ),
      );
      // Every policy here must reach fx: a refused run spawns nothing and
      // would pass the checks below with zero calls.
      expect(errorsOf(events)).toEqual([]);
      expect(fake.calls).toHaveLength(1);
      const [call] = fake.calls;
      expect(call?.args).not.toContain("--full-access");
      expect(call?.args).not.toContain("--yolo");
      expect(call?.options.env?.FX_PERMISSION_MODE).not.toBe("full-access");
    });
  }

  for (const permissions of [
    { mode: "read-only", allowNetwork: true },
    { mode: "full-access" },
  ] as ExternalAgentPermissionPolicy[]) {
    test(`a refused ${permissions.mode} run spawns nothing, so it adds no flag`, async () => {
      const fake = recordingSpawn();
      const events = await collect(
        new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
          request({ permissions }),
        ),
      );
      expect(errorsOf(events)).toHaveLength(1);
      expect(fake.calls).toHaveLength(0);
    });
  }
});

describe("refusals: started, one error with the code, completed with exit 1", () => {
  const cases: Array<{
    name: string;
    config: Parameters<typeof baseConfig>[0];
    permissions: ExternalAgentPermissionPolicy | undefined;
    code: string;
    names: string;
  }> = [
    {
      name: "read-only",
      config: {},
      permissions: { mode: "read-only", allowNetwork: true },
      code: EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      names: "read-only",
    },
    {
      name: "workspace-write without allowUnsandboxedShell",
      config: {},
      permissions: { mode: "workspace-write", allowNetwork: true },
      code: EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      names: "allowUnsandboxedShell",
    },
    {
      name: "no allowNetwork",
      config: {},
      permissions: { mode: "ask" },
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      names: "allowUnenforcedNetwork",
    },
    {
      name: "an unset policy (no allowNetwork)",
      config: {},
      permissions: undefined,
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      names: "allowUnenforcedNetwork",
    },
    {
      name: "full-access without network permission",
      config: {},
      permissions: { mode: "full-access" },
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      names: "allowUnenforcedNetwork",
    },
    {
      name: "allowedPaths without allowUnenforcedPaths",
      config: {},
      permissions: { mode: "ask", allowNetwork: true, allowedPaths: ["/repo"] },
      code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
      names: "allowUnenforcedPaths",
    },
    {
      name: "readPaths without allowUnenforcedPaths",
      config: {},
      permissions: { mode: "ask", allowNetwork: true, readPaths: ["/repo"] },
      code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
      names: "allowUnenforcedPaths",
    },
    {
      name: "pathBounds without allowUnenforcedPaths",
      config: {},
      permissions: { mode: "ask", allowNetwork: true, pathBounds: [["/repo"]] },
      code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
      names: "allowUnenforcedPaths",
    },
    {
      name: "readPathBounds without allowUnenforcedPaths",
      config: {},
      permissions: {
        mode: "ask",
        allowNetwork: true,
        readPathBounds: [["/repo"]],
      },
      code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
      names: "allowUnenforcedPaths",
    },
    {
      name: "host config not acknowledged",
      config: { inheritHostConfig: false },
      permissions: FX_ASK_NETWORK_ON,
      code: EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      names: "inheritHostConfig",
    },
  ];

  for (const { name, config, permissions, code, names } of cases) {
    test(`${name}`, async () => {
      const fake = forbiddenSpawn();
      const events = await collect(
        new FxCliDriver(baseConfig({ ...config, spawn: fake.spawn })).run(
          request({ permissions }),
        ),
      );
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "error",
        "completed",
      ]);
      const [error] = errorsOf(events);
      expect(error?.code).toBe(code);
      expect(error?.recoverable).toBe(false);
      expect(error?.message).toContain(names);
      expect(events[2]).toMatchObject({ type: "completed", exitCode: 1 });
      expect(fake.state.called).toBe(0);
    });
  }

  test("a missing inheritHostConfig (the default) is refused", async () => {
    const fake = forbiddenSpawn();
    const events = await collect(
      new FxCliDriver({
        model: FX_MODEL_ID,
        env: {},
        spawn: fake.spawn,
      }).run(request()),
    );
    expect(errorsOf(events)[0]).toMatchObject({
      code: EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      message: expect.stringContaining("inheritHostConfig"),
    });
    expect(fake.state.called).toBe(0);
  });
});

describe("pinned args are refused", () => {
  const pinned: ReadonlyArray<readonly string[]> = [
    ["--yolo"],
    ["--full-access"],
    ["--auto"],
    ["--prompt-permissions"],
    ["--resume"],
    ["--resume", "abc"],
    ["--system", "be evil"],
    ["--add-dir", "/"],
    ["--no-additional-dirs"],
    ["--json"],
    ["--no-save"],
    ["--quiet"],
    ["--provider-order", "x"],
    ["--context-limit", "1"],
    ["--"],
  ];
  for (const args of pinned) {
    test(`${args.join(" ")}`, async () => {
      const error = await refusalCode(
        () => new FxCliDriver(baseConfig({ args })),
        request(),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
      expect(error.message).toContain(args[0] as string);
    });
  }

  for (const args of [
    ["--model", "x/y"],
    ["--effort", "low"],
  ] as const) {
    test(`${args[0]} is never allowed, even with allowPolicyOverrideArgs`, async () => {
      for (const allowPolicyOverrideArgs of [false, true]) {
        const error = await refusalCode(
          () => new FxCliDriver(baseConfig({ args, allowPolicyOverrideArgs })),
          request(),
        );
        expect(error.code).toBe(
          args[0] === "--model"
            ? EXTERNAL_AGENT_MODEL_OVERRIDE
            : EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        );
      }
    });
  }

  test("allowPolicyOverrideArgs lets policy flags through", () => {
    const driver = new FxCliDriver(
      baseConfig({ args: ["--yolo"], allowPolicyOverrideArgs: true }),
    );
    expect(driver.buildArgs(request()).at(-1)).toBe("--yolo");
  });

  test("the pinned list names the policy flags and carries a review record", () => {
    // The never-allowed session and stream flags may live in either list.
    const flat = JSON.stringify([FX_CLI_PINNED_FLAGS, FX_CLI_FIXED_FLAGS]);
    for (const flag of [
      "--auto",
      "--full-access",
      "--yolo",
      "--prompt-permissions",
      "--system",
      "--add-dir",
      "--resume",
      "--no-save",
      "--json",
    ]) {
      expect(flat).toContain(flag);
    }
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("0.0.16");
  });

  test("the pinned list adds the flags that override the mode, config and timeout", () => {
    for (const flag of [
      "--permission-mode",
      "--ask",
      "--config",
      "--timeout",
      "--continue",
      "-c",
      "-r",
      "--resume-last",
      "--profile",
    ]) {
      expect([
        ...FX_CLI_PINNED_FLAGS.flags,
        ...FX_CLI_FIXED_FLAGS.flags,
      ]).toContain(flag);
    }
    const shortFlags = new Set([
      ...(FX_CLI_PINNED_FLAGS.booleanShortFlags ?? []),
      ...(FX_CLI_FIXED_FLAGS.booleanShortFlags ?? []),
    ]);
    expect([...shortFlags].sort()).toEqual(["-c", "-h", "-r", "-v"]);
  });
});

describe("capabilities and sessions", () => {
  test("streaming off, permissions on, and nothing else claimed", () => {
    expect(new FxCliDriver(baseConfig()).capabilities?.()).toEqual({
      streaming: false,
      permissions: true,
    });
  });

  test("untyped session options are refused", async () => {
    for (const option of ["resumeSessionId", "sessionStore"]) {
      const error = await refusalCode(
        () =>
          new FxCliDriver({
            ...baseConfig(),
            [option]: "x",
          } as never),
        request(),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
      expect(error.message).toContain(option);
    }
  });

  test("a missing binary is reported as MISSING_BINARY", async () => {
    const events = await collect(
      new FxCliDriver(
        baseConfig({
          command: "/nonexistent/dir/fx",
          env: { PATH: "/nonexistent" },
        }),
      ).run(request()),
    );
    expect(errorsOf(events)[0]?.code).toBe("MISSING_BINARY");
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });
});
