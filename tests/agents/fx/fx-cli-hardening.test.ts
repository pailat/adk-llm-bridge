/**
 * The batch-shim hint for fx, `--system` as a fixed flag, and the report of a
 * JSON object without `exit_code`.
 */
import { describe, expect, test } from "bun:test";
import {
  FX_CLI_FIXED_FLAGS,
  FX_CLI_PINNED_FLAGS,
  FxCliDriver,
} from "../../../src/agents/driver/fx-cli.js";
import {
  batchCommandRefusal,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
} from "../../../src/agents/driver/policy-errors.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  collect,
  errorsOf,
  forbiddenSpawn,
  makeRequest,
  printingSpawn,
} from "./helpers.js";

const request = () => makeRequest(FX_PROVIDER, {});

describe("the batch shim hint for fx", () => {
  test("does not promise a native fx.exe", () => {
    const error = Object.assign(new Error("fx.cmd is a batch file."), {
      code: "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
    });
    const message = batchCommandRefusal(error, "fx").message;
    expect(message).not.toMatch(/native fx\.exe/i);
    expect(message).toContain("no documented native Windows build");
    expect(message).toContain("batch shim");
    expect(message).toContain("where it is supported");
  });
});

describe("--system is a fixed flag", () => {
  test("it is fixed, not liftable", () => {
    expect(FX_CLI_FIXED_FLAGS.flags).toContain("--system");
    expect(FX_CLI_PINNED_FLAGS.flags).not.toContain("--system");
  });

  for (const args of [["--system", "x"], ["--system=x"], ["--system", "-"]]) {
    test(`${args.join(" ")} is refused with and without allowPolicyOverrideArgs`, () => {
      for (const allowPolicyOverrideArgs of [false, true]) {
        let refusal: { code?: string; message: string } | undefined;
        try {
          new FxCliDriver(
            baseConfig({
              args,
              allowPolicyOverrideArgs,
              spawn: forbiddenSpawn().spawn,
            }),
          );
        } catch (error) {
          refusal = error as { code?: string; message: string };
        }
        expect(refusal?.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
        expect(refusal?.message).toContain("--system");
      }
    });
  }
});

describe("a JSON object without exit_code", () => {
  const run = (stdout: string) =>
    collect(
      new FxCliDriver(
        baseConfig({ spawn: printingSpawn(stdout, 0).spawn }),
      ).run(request()),
    );

  test("is reported as FX_CLI_JSON_WITHOUT_EXIT_CODE, not as a non-JSON line", async () => {
    const events = await run(`${JSON.stringify({ output: "hi" })}\n`);
    const errors = errorsOf(events).filter(
      (e) => e.code === "FX_CLI_JSON_WITHOUT_EXIT_CODE",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ recoverable: true });
    expect(errors[0]?.message).toContain("without exit_code");
    expect(errors[0]?.message).toContain("ignored");
    expect(
      errorsOf(events).some((e) => e.code === "FX_CLI_NON_JSON_LINE"),
    ).toBe(false);
  });

  test("the excerpt is cut at 200 characters", async () => {
    const events = await run(`${JSON.stringify({ pad: "y".repeat(500) })}\n`);
    const error = errorsOf(events).find(
      (e) => e.code === "FX_CLI_JSON_WITHOUT_EXIT_CODE",
    );
    expect(error?.message).toContain("y".repeat(150));
    expect(error?.message).not.toContain("y".repeat(250));
  });

  test("text, arrays and scalars stay FX_CLI_NON_JSON_LINE", async () => {
    const events = await run("junk\n[1,2]\n42\n");
    const codes = errorsOf(events).map((e) => e.code);
    expect(codes.filter((c) => c === "FX_CLI_NON_JSON_LINE")).toHaveLength(3);
    expect(codes).not.toContain("FX_CLI_JSON_WITHOUT_EXIT_CODE");
  });
});
