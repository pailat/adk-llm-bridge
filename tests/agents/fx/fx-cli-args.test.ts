/**
 * What the `args` option and `allowedPaths` may carry. Every case
 * here builds the driver only (or runs it with a spawn that records calls), so
 * a driver that wrongly accepts an entry never starts the real `fx`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FX_CLI_FIXED_FLAGS,
  FX_CLI_PINNED_FLAGS,
  FX_CLI_PINNED_FLAGS_REVIEW,
  FxCliDriver,
} from "../../../src/agents/driver/fx-cli.js";
import {
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
} from "../../../src/agents/driver/policy-errors.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  collect,
  errorsOf,
  forbiddenSpawn,
  makeRequest,
  recordingSpawn,
} from "./helpers.js";

const request = (overrides: Parameters<typeof makeRequest>[1] = {}) =>
  makeRequest(FX_PROVIDER, overrides);

type Refusal = { code?: string; message: string };

/** The error building the driver throws, or `undefined` when it builds. */
function construct(
  args: readonly string[],
  extra: Parameters<typeof baseConfig>[0] = {},
): Refusal | undefined {
  try {
    new FxCliDriver(
      baseConfig({ args, spawn: forbiddenSpawn().spawn, ...extra }),
    );
  } catch (error) {
    return error as Refusal;
  }
  return undefined;
}

function expectRefused(
  refusal: Refusal | undefined,
  code: string,
  names: string,
): void {
  expect(refusal).toBeDefined();
  expect(refusal?.code).toBe(code);
  expect(refusal?.message).toContain(names);
}

describe("pinned flags that take a value (space and =value forms)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["--permission-mode", "full-access"],
    ["--config", "k=v"],
    ["--timeout", "1"],
    ["--profile", "x"],
  ];
  for (const [flag, value] of cases) {
    test(`${flag} ${value}`, () => {
      expectRefused(
        construct([flag, value]),
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        flag,
      );
    });
    test(`${flag}=${value}`, () => {
      expectRefused(
        construct([`${flag}=${value}`]),
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        flag,
      );
    });
  }

  test("every pinned value flag, old and new, is refused in the =value form and names the flag", () => {
    const valueFlags = [
      "--provider-order",
      "--resume",
      "--resume-id",
      "--add-dir",
      "--context-limit",
      ...cases.map(([flag]) => flag),
    ];
    for (const flag of valueFlags) {
      const refusal = construct([`${flag}=x`]);
      expect(refusal?.code, `${flag}=x`).toBe(
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      );
      expect(refusal?.message, `${flag}=x`).toContain(flag);
    }
  });
});

describe("pinned boolean flags and clusters", () => {
  for (const flag of ["--ask", "--continue", "-c", "-r", "--resume-last"]) {
    test(`${flag}`, () => {
      expectRefused(construct([flag]), EXTERNAL_AGENT_OPTION_UNSUPPORTED, flag);
    });
  }

  for (const cluster of ["-vc", "-hr"]) {
    test(`the cluster ${cluster} is split and refused`, () => {
      expectRefused(
        construct([cluster]),
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        cluster,
      );
    });
  }

  for (const entry of ["--resume-abc123", "--resume-"]) {
    test(`${entry} (the --resume-<id> form)`, () => {
      expectRefused(
        construct([entry]),
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        entry,
      );
    });
  }
});

describe("--provider is never allowed, like --model", () => {
  for (const args of [["--provider", "x"], ["--provider=x"]]) {
    test(`${args.join(" ")} is refused with and without allowPolicyOverrideArgs`, () => {
      for (const allowPolicyOverrideArgs of [false, true]) {
        expectRefused(
          construct(args, { allowPolicyOverrideArgs }),
          EXTERNAL_AGENT_MODEL_OVERRIDE,
          "--provider",
        );
      }
    });
  }

  test("--provider-order, --provider-strict and --no-provider-strict stay pinned policy flags, unlike --provider", () => {
    // --provider changes which model answers, so the opt-in never lifts it.
    expect(
      construct(["--provider", "x"], { allowPolicyOverrideArgs: true })?.code,
    ).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    for (const args of [
      ["--provider-order", "a,b"],
      ["--provider-strict"],
      ["--no-provider-strict"],
    ]) {
      expectRefused(
        construct(args),
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        args[0] as string,
      );
      expect(
        construct(args, { allowPolicyOverrideArgs: true }),
      ).toBeUndefined();
    }
  });
});

describe("allowPolicyOverrideArgs", () => {
  test("lifts --permission-mode but not --provider", () => {
    // Without the opt-in the flag is refused ...
    expectRefused(
      construct(["--permission-mode", "full-access"]),
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      "--permission-mode",
    );
    // ... with it the flag goes through, last ...
    const driver = new FxCliDriver(
      baseConfig({
        args: ["--permission-mode", "full-access"],
        allowPolicyOverrideArgs: true,
      }),
    );
    expect(driver.buildArgs(request()).slice(-2)).toEqual([
      "--permission-mode",
      "full-access",
    ]);
    // ... and --provider is refused anyway.
    expectRefused(
      construct(["--provider", "x"], { allowPolicyOverrideArgs: true }),
      EXTERNAL_AGENT_MODEL_OVERRIDE,
      "--provider",
    );
  });

  test("the permission, timeout and profile flags are in the lifted set: --ask, --timeout, --profile", () => {
    for (const args of [["--ask"], ["--timeout", "1"], ["--profile", "x"]]) {
      expect(construct(args)?.code, args.join(" ")).toBe(
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      );
      expect(
        construct(args, { allowPolicyOverrideArgs: true }),
        args.join(" "),
      ).toBeUndefined();
    }
    expect(FX_CLI_PINNED_FLAGS.flags).toContain("--permission-mode");
  });
});

describe("session flags and the stream flags are never allowed, even with allowPolicyOverrideArgs", () => {
  const sessionCases: ReadonlyArray<readonly [readonly string[], string]> = [
    [["--resume", "last"], "--resume"],
    [["--resume=last"], "--resume"],
    [["--resume"], "--resume"],
    [["--resume-id", "abc"], "--resume-id"],
    [["--resume-id=abc"], "--resume-id"],
    [["--resume-last"], "--resume-last"],
    [["--resume-abc123"], "--resume-abc123"],
    [["--continue"], "--continue"],
    [["-c"], "-c"],
    [["-r"], "-r"],
    [["-vc"], "-vc"],
    [["-hr"], "-hr"],
  ];
  for (const [args, names] of sessionCases) {
    test(`${args.join(" ")} is refused with and without the opt-in`, () => {
      for (const allowPolicyOverrideArgs of [false, true]) {
        expectRefused(
          construct(args, { allowPolicyOverrideArgs }),
          EXTERNAL_AGENT_OPTION_UNSUPPORTED,
          names,
        );
      }
    });
  }

  test("--no-save and --json stay refused with the opt-in", () => {
    // The session flags above are the part that used to be liftable.
    expect(
      construct(["--resume-id", "abc"], { allowPolicyOverrideArgs: true })
        ?.code,
    ).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
    for (const flag of ["--no-save", "--json"]) {
      for (const allowPolicyOverrideArgs of [false, true]) {
        expectRefused(
          construct([flag], { allowPolicyOverrideArgs }),
          EXTERNAL_AGENT_OPTION_UNSUPPORTED,
          flag,
        );
      }
    }
  });

  test("the opt-in still lifts the other policy flags", () => {
    expect(
      construct(["--resume", "last"], { allowPolicyOverrideArgs: true })?.code,
    ).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
    expect(
      construct(["--yolo", "--ask"], { allowPolicyOverrideArgs: true }),
    ).toBeUndefined();
  });
});

describe("no prompt text in args", () => {
  test('args: ["hello"] is refused, naming args and the index', () => {
    const refusal = construct(["hello"]);
    expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "args");
    expect(refusal?.message).toMatch(/\b0\b/);
  });

  test('["--debug", "hello"] is refused at index 1', () => {
    const refusal = construct(["--debug", "hello"]);
    expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "args");
    expect(refusal?.message).toMatch(/\b1\b/);
  });

  test("the message never repeats more than the first 40 characters of the entry", () => {
    const entry = `${"abcdefghij".repeat(10)}`;
    const refusal = construct(["--debug", entry]);
    expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "args");
    expect(refusal?.message).not.toContain(entry.slice(0, 41));
  });

  test("a value after a value flag is kept; a bare word after it is refused", () => {
    const optIn = { allowPolicyOverrideArgs: true };
    // `--add-dir` takes a value in the space form.
    expect(construct(["--add-dir", "/x"], optIn)).toBeUndefined();
    // `--add-dir` alone is accepted at construction (fx reports it).
    expect(construct(["--add-dir"], optIn)).toBeUndefined();
    const driver = new FxCliDriver(
      baseConfig({ args: ["--add-dir", "/x"], ...optIn }),
    );
    expect(driver.buildArgs(request()).slice(-2)).toEqual(["--add-dir", "/x"]);
    // A third entry with no flag in front of it is prompt text.
    const refusal = construct(["--add-dir", "/x", "hello"], optIn);
    expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "args");
    expect(refusal?.message).toMatch(/\b2\b/);
  });

  test("the =value form does not consume the next entry", () => {
    const optIn = { allowPolicyOverrideArgs: true };
    expect(construct(["--add-dir=/x"], optIn)).toBeUndefined();
    expectRefused(
      construct(["--add-dir=/x", "hello"], optIn),
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      "args",
    );
  });

  const valueFlags = [
    "--permission-mode",
    "--timeout",
    "--add-dir",
    "--context-limit",
    "--profile",
    "--provider-order",
  ];
  for (const flag of valueFlags) {
    test(`${flag} takes the next entry as its value, and nothing after that`, () => {
      // allowPolicyOverrideArgs lifts the pinned check only; the bare-word
      // check still applies.
      expect(
        construct([flag, "v"], { allowPolicyOverrideArgs: true }),
        flag,
      ).toBeUndefined();
      const refusal = construct([flag, "v", "word"], {
        allowPolicyOverrideArgs: true,
      });
      expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "args");
    });
  }
});

describe("allowedPaths entries become --add-dir values only when absolute", () => {
  const optIns = {
    allowUnenforcedPaths: true,
    inheritHostConfig: true,
  } as const;

  for (const bad of ["-rf", "rel/dir", "--yolo", ""]) {
    test(`allowedPaths ${JSON.stringify(bad)} is refused and fx never starts`, async () => {
      const fake = recordingSpawn();
      const events = await collect(
        new FxCliDriver(baseConfig({ ...optIns, spawn: fake.spawn })).run(
          request({
            permissions: {
              mode: "ask",
              allowNetwork: true,
              allowedPaths: ["/repo", bad],
            },
          }),
        ),
      );
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "error",
        "completed",
      ]);
      const [error] = errorsOf(events);
      expect(error?.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
      expect(error?.recoverable).toBe(false);
      expect(error?.message).toContain("allowedPaths");
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
      expect(fake.calls).toHaveLength(0);
    });
  }

  test("absolute paths still become --add-dir pairs", async () => {
    const fake = recordingSpawn();
    const events = await collect(
      new FxCliDriver(baseConfig({ ...optIns, spawn: fake.spawn })).run(
        request({
          permissions: {
            mode: "ask",
            allowNetwork: true,
            allowedPaths: ["/repo", "/tmp"],
          },
        }),
      ),
    );
    expect(errorsOf(events)).toEqual([]);
    expect(fake.calls[0]?.args.slice(0, 4)).toEqual([
      "--add-dir",
      "/repo",
      "--add-dir",
      "/tmp",
    ]);
  });
});

describe("a lone - is the prompt marker of fx", () => {
  test('args ["-"] is refused with and without the opt-in, naming args and the index', () => {
    for (const allowPolicyOverrideArgs of [false, true]) {
      const refusal = construct(["-"], { allowPolicyOverrideArgs });
      expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "args");
      expect(refusal?.message).toMatch(/\b0\b/);
    }
  });

  test('["--debug", "-"] is refused at index 1', () => {
    for (const allowPolicyOverrideArgs of [false, true]) {
      const refusal = construct(["--debug", "-"], { allowPolicyOverrideArgs });
      expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "args");
      expect(refusal?.message).toMatch(/\b1\b/);
    }
  });

  test("a - that is the value of a value flag in the space form is accepted", () => {
    expect(
      construct(["--add-dir", "-"], { allowPolicyOverrideArgs: true }),
    ).toBeUndefined();
  });

  test("a - after that value is refused again", () => {
    expectRefused(
      construct(["--add-dir", "-", "-"], { allowPolicyOverrideArgs: true }),
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      "args",
    );
  });
});

describe("-- ends the flags of fx and is never allowed", () => {
  const cases: ReadonlyArray<readonly string[]> = [
    ["--"],
    ["--", "--foo"],
    ["--debug", "--"],
  ];
  for (const args of cases) {
    test(`${JSON.stringify(args)} is refused with and without the opt-in`, () => {
      for (const allowPolicyOverrideArgs of [false, true]) {
        const refusal = construct(args, { allowPolicyOverrideArgs });
        expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "--");
        expect(refusal?.message).toContain("prompt");
        expect(refusal?.message).not.toContain("allowPolicyOverrideArgs: true");
      }
    });
  }

  test("-- is a fixed flag, not a pinned one", () => {
    expect(FX_CLI_FIXED_FLAGS.flags).toContain("--");
    expect(FX_CLI_PINNED_FLAGS.flags).not.toContain("--");
  });
});

describe("--config is never allowed: a key such as provider or model changes which model answers", () => {
  const cases: ReadonlyArray<readonly string[]> = [
    ["--config", "provider=x"],
    ["--config=provider=x"],
    ["--config", "max_agent_steps=3"],
    ["--config=k=v"],
  ];
  for (const args of cases) {
    test(`${args.join(" ")} is refused with and without the opt-in`, () => {
      for (const allowPolicyOverrideArgs of [false, true]) {
        const refusal = construct(args, { allowPolicyOverrideArgs });
        expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, "--config");
        expect(refusal?.message).not.toContain("allowPolicyOverrideArgs: true");
      }
    });
  }

  test("--config is a fixed flag, not a pinned one", () => {
    expect(FX_CLI_FIXED_FLAGS.flags).toContain("--config");
    expect(FX_CLI_PINNED_FLAGS.flags).not.toContain("--config");
  });
});

describe("the pinned-flags review record", () => {
  test("names the fx version, both help pages, and both checks of unknown flag spellings, with the date", () => {
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("0.0.16");
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("`fx --help`");
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("`fx ask --help`");
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("shortened");
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("letter case");
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("2026-11-11");
    expect(FX_CLI_PINNED_FLAGS_REVIEW).toContain("every fx version review");
  });
});

describe("the isolation doc for fx", () => {
  const doc = readFileSync(
    join(import.meta.dir, "../../../docs/external-agent-isolation.md"),
    "utf8",
  );
  const fxStart = doc.indexOf("\n## fx\n");
  const fxSection = doc.slice(fxStart, doc.indexOf("\n## ", fxStart + 1));

  test("says a project .fx.json also sets fx settings and the agent can write it", () => {
    expect(fxSection).toContain(".fx.json");
    expect(fxSection).toContain(
      "https://fx.sh/docs/configure-fx/permissions.md",
    );
  });

  test("records the shortened-flag and letter-case check with its date", () => {
    expect(fxSection).toContain("shortened");
    expect(fxSection.replace(/\s+/g, " ")).toContain("letter case");
    expect(fxSection).toContain("2026-11-11");
  });
});

describe("flags the v1 driver leaves out are refused", () => {
  const unsupported = [
    ["--image", "/tmp/a.png"],
    ["--image=/tmp/a.png"],
    ["--fast"],
    ["--ultrafast"],
  ] as const;
  for (const args of unsupported) {
    test(`${JSON.stringify(args)} is refused with and without the opt-in`, () => {
      for (const allowPolicyOverrideArgs of [false, true]) {
        const refusal = construct(args, { allowPolicyOverrideArgs });
        expectRefused(refusal, EXTERNAL_AGENT_OPTION_UNSUPPORTED, args[0]);
        expect(refusal?.message).toContain("not supported");
        expect(refusal?.message).not.toContain("allowPolicyOverrideArgs: true");
      }
    });
  }
});
