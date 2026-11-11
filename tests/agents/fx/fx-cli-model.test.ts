import { describe, expect, test } from "bun:test";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import {
  FX_MODEL_ENV,
  MODEL_ALIAS_DENYLIST,
} from "../../../src/agents/driver/model.js";
import {
  EXTERNAL_AGENT_MODEL_INVALID,
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_MODEL_REQUIRED,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
} from "../../../src/agents/driver/policy-errors.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  collect,
  errorsOf,
  FX_MODEL_ID,
  forbiddenSpawn,
  makeRequest,
  recordingSpawn,
} from "./helpers.js";

function codeOfBuild(build: () => unknown): { code?: string; message: string } {
  try {
    build();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("did not throw");
}

describe("model option", () => {
  test("no model is refused by default (requireExplicitModel defaults to true)", () => {
    const error = codeOfBuild(
      () => new FxCliDriver({ inheritHostConfig: true, env: {} }),
    );
    expect(error.code).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
  });

  test("the driver exposes requireExplicitModel", () => {
    expect(new FxCliDriver(baseConfig()).requireExplicitModel).toBe(true);
    expect(
      new FxCliDriver(baseConfig({ requireExplicitModel: false }))
        .requireExplicitModel,
    ).toBe(false);
  });

  test("requireExplicitModel: false runs without --model", async () => {
    const fake = recordingSpawn();
    await collect(
      new FxCliDriver(
        baseConfig({
          model: undefined,
          requireExplicitModel: false,
          spawn: fake.spawn,
        }),
      ).run(makeRequest(FX_PROVIDER)),
    );
    expect(fake.calls[0]?.args).not.toContain("--model");
  });

  for (const model of ["", "has space", "-x", "a\nb", "x".repeat(257)]) {
    test(`an invalid model id ${JSON.stringify(model.slice(0, 12))} is refused`, () => {
      const error = codeOfBuild(() => new FxCliDriver(baseConfig({ model })));
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_INVALID);
    });
  }

  test("a provider/model id is accepted and sent as --model", async () => {
    const fake = recordingSpawn();
    await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        makeRequest(FX_PROVIDER),
      ),
    );
    const args = fake.calls[0]?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe(FX_MODEL_ID);
  });

  test("the fx denylist exists and holds no alias", () => {
    expect(MODEL_ALIAS_DENYLIST.fx).toEqual({ exact: [], prefixes: [] });
  });
});

describe("model env", () => {
  test("FX_MODEL_ENV lists the variables that change the model or routing", () => {
    expect([...FX_MODEL_ENV]).toEqual(["FX_MODEL", "FX_PROVIDER"]);
  });

  for (const name of FX_MODEL_ENV) {
    for (const spelling of [name, name.toLowerCase()]) {
      test(`${spelling} in the run env is refused, naming it and never its value`, async () => {
        const fake = forbiddenSpawn();
        const events = await collect(
          new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
            makeRequest(
              { ...FX_PROVIDER, envAllowlist: [spelling] },
              {
                credential: {
                  kind: "env",
                  env: { [spelling]: "super-secret-value" },
                },
              },
            ),
          ),
        );
        expect(events.map((e) => e.type)).toEqual([
          "started",
          "error",
          "completed",
        ]);
        const [error] = errorsOf(events);
        expect(error?.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
        expect(error?.recoverable).toBe(false);
        expect(error?.message).toContain(spelling);
        expect(error?.message).not.toContain("super-secret-value");
        expect(events[2]).toMatchObject({ exitCode: 1 });
        expect(fake.state.called).toBe(0);
      });
    }
  }

  test("the built-in provider forwards no model variable", () => {
    for (const name of FX_PROVIDER.envAllowlist ?? []) {
      expect(FX_MODEL_ENV).not.toContain(name.toUpperCase());
    }
  });

  test("the model env check wins over the other pre-spawn refusals", async () => {
    const fake = forbiddenSpawn();
    const events = await collect(
      new FxCliDriver(
        baseConfig({ spawn: fake.spawn, inheritHostConfig: false }),
      ).run(
        makeRequest(
          { ...FX_PROVIDER, envAllowlist: ["FX_MODEL"] },
          {
            permissions: { mode: "read-only" },
            credential: { kind: "env", env: { FX_MODEL: "x/y" } },
          },
        ),
      ),
    );
    expect(errorsOf(events)[0]?.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    expect(errorsOf(events)[0]?.code).not.toBe(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    );
  });
});
