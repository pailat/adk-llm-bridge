import { describe, expect, test } from "bun:test";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  collect,
  errorsOf,
  forbiddenSpawn,
  makeRequest,
} from "./helpers.js";

const CODE = "EXTERNAL_AGENT_SESSIONS_UNSUPPORTED";

const withSession = (overrides: Parameters<typeof makeRequest>[1] = {}) =>
  makeRequest(FX_PROVIDER, { runtimeSession: { id: "x" }, ...overrides });

describe("runtimeSession", () => {
  test("is refused with started, one error and completed, and nothing is spawned", async () => {
    const fake = forbiddenSpawn();
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(withSession()),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    const [error] = errorsOf(events);
    expect(error).toMatchObject({ code: CODE, recoverable: false });
    expect(error?.message).toContain("FxCliDriver");
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    expect(fake.state.called).toBe(0);
  });

  const others: [string, Parameters<typeof withSession>[0], boolean][] = [
    [
      "a refused read-only policy",
      { permissions: { mode: "read-only" } },
      true,
    ],
    ["a missing inheritHostConfig", {}, false],
    [
      "FX_MODEL in the credential env",
      {
        provider: { ...FX_PROVIDER, envAllowlist: ["FX_MODEL"] },
        credential: { kind: "env", env: { FX_MODEL: "x/y" } },
      },
      true,
    ],
    [
      "allowedPaths",
      {
        permissions: {
          mode: "ask",
          allowNetwork: true,
          allowedPaths: ["/tmp/a"],
        },
      },
      true,
    ],
  ];
  for (const [label, overrides, inherit] of others) {
    test(`is reported before ${label}`, async () => {
      const fake = forbiddenSpawn();
      const events = await collect(
        new FxCliDriver(
          baseConfig({ spawn: fake.spawn, inheritHostConfig: inherit }),
        ).run(withSession(overrides)),
      );
      expect(errorsOf(events)).toHaveLength(1);
      expect(errorsOf(events)[0]?.code).toBe(CODE);
      expect(fake.state.called).toBe(0);
    });
  }
});
