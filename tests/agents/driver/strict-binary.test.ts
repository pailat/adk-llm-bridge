import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CLAUDE_STRICT_BINARY_CHECK,
  ClaudeAgentSdkDriver,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  CODEX_STRICT_BINARY_CHECK,
  CodexSdkDriver,
} from "../../../src/agents/driver/codex-sdk.js";
import { ExternalAgentPolicyError } from "../../../src/agents/driver/policy-errors.js";
import {
  bundledBinaryLocations,
  strictBinaryRefusal,
} from "../../../src/agents/driver/strict-binary.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
} from "../../../src/agents/provider/schema.js";

/** The checkout: it holds the bridge modules these tests import. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "../../.."));

const CHECK = {
  runtime: "Test SDK",
  sdkPackage: "@scope/sdk",
  option: "pathToBinary",
  envVar: "TEST_EXECUTABLE",
} as const;

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A fake install: `<root>/node_modules/<sdk>` with platform packages. */
function fakeInstall(root: string): string {
  const sdk = join(root, "node_modules", "@scope", "sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@scope/sdk",
      optionalDependencies: {
        "@scope/sdk-this-platform": "1.0.0",
        "@scope/sdk-other-platform": "1.0.0",
      },
    }),
  );
  const platform = join(root, "node_modules", "@scope", "sdk-this-platform");
  mkdirSync(platform, { recursive: true });
  writeFileSync(join(platform, "package.json"), "{}");
  const bin = join(root, "node_modules", "@scope", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "package.json"),
    JSON.stringify({ optionalDependencies: { "@scope/bin-native": "1" } }),
  );
  const native = join(root, "node_modules", "@scope", "bin-native");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "package.json"), "{}");
  const module = join(root, "dist", "index.js");
  mkdirSync(dirname(module), { recursive: true });
  writeFileSync(module, "");
  return module;
}

describe("bundledBinaryLocations", () => {
  test("lists the bridge module, the SDK, its installed platform packages and the binary packages", () => {
    const root = tempDir("strict-locate-");
    try {
      const module = fakeInstall(root);
      const { locations, sdkMissing } = bundledBinaryLocations(
        "@scope/sdk",
        ["@scope/bin"],
        module,
      );
      expect(sdkMissing).toBeUndefined();
      expect(locations).toEqual([
        module,
        join(root, "node_modules", "@scope", "sdk"),
        join(root, "node_modules", "@scope", "sdk-this-platform"),
        join(root, "node_modules", "@scope", "bin"),
        join(root, "node_modules", "@scope", "bin-native"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lists a symlinked package both where it is found and where it points", () => {
    const root = tempDir("strict-link-");
    const store = tempDir("strict-store-");
    try {
      const module = join(root, "dist", "index.js");
      mkdirSync(dirname(module), { recursive: true });
      writeFileSync(module, "");
      const real = join(store, "sdk");
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "package.json"), "{}");
      mkdirSync(join(root, "node_modules", "@scope"), { recursive: true });
      symlinkSync(real, join(root, "node_modules", "@scope", "sdk"));
      const { locations } = bundledBinaryLocations("@scope/sdk", [], module);
      expect(locations).toEqual([
        module,
        join(root, "node_modules", "@scope", "sdk"),
        real,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  test("reports an SDK that cannot be found", () => {
    const root = tempDir("strict-nosdk-");
    try {
      const module = join(root, "index.js");
      writeFileSync(module, "");
      expect(bundledBinaryLocations("@scope/absent-sdk", [], module)).toEqual({
        locations: [module],
        sdkMissing: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("strictBinaryRefusal", () => {
  const outside = tempDir("strict-outside-");
  const workspace = tempDir("strict-workspace-");

  test("lets the SDK fall back when every location is outside the roots", () => {
    expect(
      strictBinaryRefusal(CHECK, [workspace], () => ({
        locations: [join(outside, "bridge.js"), join(outside, "sdk")],
      })),
    ).toBeUndefined();
  });

  for (const [label, index] of [
    ["the bridge install", 0],
    ["the SDK package", 1],
    ["a platform package", 2],
  ] as const) {
    test(`refuses with MISSING_BINARY when ${label} is inside a writable root`, () => {
      const locations = [
        join(outside, "bridge.js"),
        join(outside, "sdk"),
        join(outside, "sdk-platform"),
      ];
      locations[index] = join(workspace, "node_modules", "x");
      const error = strictBinaryRefusal(CHECK, [workspace], () => ({
        locations,
      }));
      expect(error).toBeInstanceOf(ExternalAgentPolicyError);
      expect(error?.code).toBe("MISSING_BINARY");
      expect(error?.recoverable).toBe(false);
      expect(error?.message).toContain(locations[index] as string);
      expect(error?.message).toContain("pathToBinary");
      expect(error?.message).toContain("TEST_EXECUTABLE");
      expect(error?.message).toContain("strictBinaryResolution");
      expect(error?.message).toContain("install the host");
    });
  }

  test("a writable root nested inside a package counts as overlapping", () => {
    const error = strictBinaryRefusal(
      CHECK,
      [join(outside, "sdk-platform", "vendor")],
      () => ({
        locations: [
          join(outside, "bridge.js"),
          join(outside, "sdk"),
          join(outside, "sdk-platform"),
        ],
      }),
    );
    expect(error?.code).toBe("MISSING_BINARY");
    expect(error?.message).toContain(join(outside, "sdk-platform"));
  });

  test("a root nested inside a symlinked package's target counts as overlapping", () => {
    const target = join(outside, "store-sdk");
    mkdirSync(join(target, "vendor"), { recursive: true });
    const link = join(outside, "linked-store-sdk");
    symlinkSync(target, link);
    try {
      const error = strictBinaryRefusal(
        CHECK,
        [join(target, "vendor")],
        () => ({
          locations: [join(outside, "bridge.js"), link],
        }),
      );
      expect(error?.code).toBe("MISSING_BINARY");
    } finally {
      rmSync(link, { force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("a sibling root that only shares a name prefix does not overlap", () => {
    expect(
      strictBinaryRefusal(CHECK, [join(outside, "sdk-other")], () => ({
        locations: [join(outside, "bridge.js"), join(outside, "sdk")],
      })),
    ).toBeUndefined();
  });

  test("a root equal to the location counts as inside", () => {
    const error = strictBinaryRefusal(CHECK, [join(outside, "sdk")], () => ({
      locations: [join(outside, "bridge.js"), join(outside, "sdk")],
    }));
    expect(error?.code).toBe("MISSING_BINARY");
  });

  test("a symlink inside a root counts as inside, wherever it points", () => {
    const link = join(workspace, "linked-sdk");
    symlinkSync(outside, link);
    try {
      const error = strictBinaryRefusal(CHECK, [workspace], () => ({
        locations: [join(outside, "bridge.js"), link],
      }));
      expect(error?.message).toContain(link);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("a symlink outside pointing into a root counts as inside", () => {
    const target = join(workspace, "planted-sdk");
    mkdirSync(target, { recursive: true });
    const link = join(outside, "sdk-link");
    symlinkSync(target, link);
    try {
      const error = strictBinaryRefusal(CHECK, [workspace], () => ({
        locations: [join(outside, "bridge.js"), link],
      }));
      expect(error?.code).toBe("MISSING_BINARY");
    } finally {
      rmSync(link, { force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("a location that cannot be resolved counts as inside", () => {
    // A symlink loop has no real path, so nothing proves it is outside.
    const a = join(outside, "loop-a");
    const b = join(outside, "loop-b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    try {
      const error = strictBinaryRefusal(CHECK, [workspace], () => ({
        locations: [join(outside, "bridge.js"), a],
      }));
      expect(error?.code).toBe("MISSING_BINARY");
      expect(error?.message).toContain(a);
    } finally {
      rmSync(a, { force: true });
      rmSync(b, { force: true });
    }
  });

  test("fails closed when the SDK package cannot be located", () => {
    const error = strictBinaryRefusal(CHECK, [workspace], () => ({
      locations: [join(outside, "bridge.js")],
      sdkMissing: true,
    }));
    expect(error?.code).toBe("MISSING_BINARY");
    expect(error?.message).toContain("could not be located");
    expect(error?.message).toContain("@scope/sdk");
  });
});

describe("ClaudeAgentSdkDriver strictBinaryResolution", () => {
  /** A fake SDK that records the executable it was given. */
  function fakeSdk(seen: Array<string | undefined>) {
    return {
      query: ({
        options,
      }: {
        options: { pathToClaudeCodeExecutable?: string };
      }) => {
        seen.push(options.pathToClaudeCodeExecutable);
        return (async function* () {
          yield { type: "result", subtype: "success", result: "ok" } as never;
        })() as never;
      },
    };
  }

  function run(
    driver: ClaudeAgentSdkDriver,
    workingDirectory: string,
  ): Promise<ExternalAgentEvent[]> {
    return collect(
      driver.run({
        provider: CLAUDE_PROVIDER,
        context: {} as never,
        workingDirectory,
      }),
    );
  }

  test("refuses before the SDK starts when the bridge install is inside the working directory", async () => {
    const seen: Array<string | undefined> = [];
    const home = tempDir("strict-claude-home-");
    try {
      const driver = new ClaudeAgentSdkDriver({
        env: { PATH: "", HOME: home },
        sdk: fakeSdk(seen) as never,
        strictBinaryResolution: true,
      });
      const events = await run(driver, CHECKOUT);
      expect(seen).toHaveLength(0);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code: "MISSING_BINARY",
        recoverable: false,
      });
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses when only the SDK package is inside the working directory", async () => {
    const seen: Array<string | undefined> = [];
    const home = tempDir("strict-claude-home-");
    const sdkDir = realpathSync(
      join(CHECKOUT, "node_modules", "@anthropic-ai", "claude-agent-sdk"),
    );
    try {
      const events = await run(
        new ClaudeAgentSdkDriver({
          env: { PATH: "", HOME: home },
          sdk: fakeSdk(seen) as never,
          strictBinaryResolution: true,
        }),
        sdkDir,
      );
      expect(seen).toHaveLength(0);
      const error = events.find((event) => event.type === "error");
      expect(error).toMatchObject({ code: "MISSING_BINARY" });
      expect(JSON.stringify(error)).toContain("CLAUDE_CODE_EXECUTABLE");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses when only allowedPaths holds the install", async () => {
    // The working directory is inside allowedPaths (the driver requires it)
    // but holds nothing; the checkout is reachable only through allowedPaths.
    const seen: Array<string | undefined> = [];
    const home = tempDir("strict-claude-home-");
    const wd = realpathSync(mkdtempSync(join(CHECKOUT, ".strict-wd-")));
    try {
      const events = await collect(
        new ClaudeAgentSdkDriver({
          env: { PATH: "", HOME: home },
          sdk: fakeSdk(seen) as never,
          strictBinaryResolution: true,
        }).run({
          provider: CLAUDE_PROVIDER,
          context: {} as never,
          workingDirectory: wd,
          permissions: {
            mode: "workspace-write",
            allowedPaths: [wd, CHECKOUT],
          },
        }),
      );
      expect(seen).toHaveLength(0);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code: "MISSING_BINARY",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(wd, { recursive: true, force: true });
    }
  });

  test("an explicit executable is used as given, strict or not", async () => {
    const seen: Array<string | undefined> = [];
    const home = tempDir("strict-claude-home-");
    try {
      const executable = join(home, "claude");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const events = await run(
        new ClaudeAgentSdkDriver({
          env: { PATH: "", HOME: home, CLAUDE_CODE_EXECUTABLE: executable },
          sdk: fakeSdk(seen) as never,
          strictBinaryResolution: true,
        }),
        CHECKOUT,
      );
      expect(seen).toEqual([executable]);
      expect(events.some((event) => event.type === "error")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("lets the SDK fall back when the install is outside the working directory", async () => {
    const seen: Array<string | undefined> = [];
    const home = tempDir("strict-claude-home-");
    const workspace = tempDir("strict-claude-ws-");
    try {
      const events = await run(
        new ClaudeAgentSdkDriver({
          env: { PATH: "", HOME: home },
          sdk: fakeSdk(seen) as never,
          strictBinaryResolution: true,
        }),
        workspace,
      );
      expect(seen).toHaveLength(1);
      expect(events.some((event) => event.type === "error")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  for (const [label, strict] of [
    ["off by default", undefined],
    ["explicitly false", false],
  ] as const) {
    test(`${label}: the SDK falls back exactly as before`, async () => {
      const seen: Array<string | undefined> = [];
      const home = tempDir("strict-claude-home-");
      try {
        const events = await run(
          new ClaudeAgentSdkDriver({
            env: { PATH: "", HOME: home },
            sdk: fakeSdk(seen) as never,
            ...(strict === undefined ? {} : { strictBinaryResolution: strict }),
          }),
          CHECKOUT,
        );
        expect(seen).toEqual([undefined]);
        expect(events.some((event) => event.type === "error")).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe("CodexSdkDriver strictBinaryResolution", () => {
  const NETWORK: ExternalAgentRunRequest["permissions"] = {
    mode: "workspace-write",
    allowNetwork: true,
  };

  /** A Codex constructor that records the binary path it was given. */
  function fakeCodex(seen: Array<string | undefined>) {
    return class {
      constructor(options: { codexPathOverride?: string }) {
        seen.push(options.codexPathOverride);
        throw new Error("fake codex: stop here");
      }
    } as never;
  }

  function run(
    driver: CodexSdkDriver,
    workingDirectory: string,
  ): Promise<ExternalAgentEvent[]> {
    return collect(
      driver.run({
        provider: CODEX_PROVIDER,
        context: { input: "hi" } as never,
        permissions: NETWORK,
        workingDirectory,
      }),
    );
  }

  test("refuses before the client is built when the install is inside the working directory", async () => {
    const seen: Array<string | undefined> = [];
    const events = await run(
      new CodexSdkDriver({
        env: { PATH: "" },
        Codex: fakeCodex(seen),
        strictBinaryResolution: true,
      }),
      CHECKOUT,
    );
    expect(seen).toHaveLength(0);
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({ code: "MISSING_BINARY", recoverable: false });
    expect(JSON.stringify(error)).toContain("CODEX_EXECUTABLE");
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("refuses when only allowedPaths holds the install", async () => {
    const seen: Array<string | undefined> = [];
    const wd = tempDir("strict-codex-ws-");
    try {
      const events = await collect(
        new CodexSdkDriver({
          env: { PATH: "" },
          Codex: fakeCodex(seen),
          allowUnenforcedPaths: true,
          strictBinaryResolution: true,
        }).run({
          provider: CODEX_PROVIDER,
          context: { input: "hi" } as never,
          permissions: { ...NETWORK, allowedPaths: [CHECKOUT] },
          workingDirectory: wd,
        }),
      );
      expect(seen).toHaveLength(0);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code: "MISSING_BINARY",
      });
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  test("an explicit codexPathOverride is used as given", async () => {
    const seen: Array<string | undefined> = [];
    const dir = tempDir("strict-codex-bin-");
    try {
      const binary = join(dir, "codex");
      writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await run(
        new CodexSdkDriver({
          env: { PATH: "" },
          Codex: fakeCodex(seen),
          codexPathOverride: binary,
          strictBinaryResolution: true,
        }),
        CHECKOUT,
      );
      expect(seen).toEqual([binary]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, strict] of [
    ["off by default", undefined],
    ["explicitly false", false],
  ] as const) {
    test(`${label}: the SDK falls back exactly as before`, async () => {
      const seen: Array<string | undefined> = [];
      const events = await run(
        new CodexSdkDriver({
          env: { PATH: "" },
          Codex: fakeCodex(seen),
          ...(strict === undefined ? {} : { strictBinaryResolution: strict }),
        }),
        CHECKOUT,
      );
      expect(seen).toEqual([undefined]);
      expect(
        events.some(
          (event) => event.type === "error" && event.code === "MISSING_BINARY",
        ),
      ).toBe(false);
    });
  }

  test("a prebuilt sdk client cannot be checked, so the constructor refuses the option", () => {
    expect(
      () =>
        new CodexSdkDriver({
          sdk: { startThread: () => ({}) } as never,
          strictBinaryResolution: true,
        }),
    ).toThrow(
      expect.objectContaining({ code: "EXTERNAL_AGENT_OPTION_UNSUPPORTED" }),
    );
  });
});

describe("the drivers' checks cover the packages their SDKs load the binary from", () => {
  /** Real paths of the located packages, by package name. */
  function located(check: typeof CODEX_STRICT_BINARY_CHECK): string[] {
    return bundledBinaryLocations(check.sdkPackage, check.binaryPackages)
      .locations.slice(1)
      .map(
        (location) =>
          JSON.parse(readFileSync(join(location, "package.json"), "utf8"))
            .name as string,
      );
  }

  test("Codex: @openai/codex-sdk, @openai/codex and its platform package", () => {
    const names = located(CODEX_STRICT_BINARY_CHECK);
    expect(names).toContain("@openai/codex-sdk");
    // @openai/codex-sdk resolves its binary through @openai/codex
    // (findCodexPath), and the platform package is an alias of it.
    expect(
      names.filter((name) => name === "@openai/codex").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("Claude: the SDK and its platform package", () => {
    const names = located(CLAUDE_STRICT_BINARY_CHECK);
    expect(names).toContain("@anthropic-ai/claude-agent-sdk");
    expect(
      names.some((name) => name.startsWith("@anthropic-ai/claude-agent-sdk-")),
    ).toBe(true);
  });
});
