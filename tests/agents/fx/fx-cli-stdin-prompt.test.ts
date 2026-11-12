/**
 * The fx driver gives the prompt to `fx ask` on stdin, never as an argument
 * (fx reads stdin when no prompt args are given, and a prompt such as `update`
 * or `--yolo` must not be read as a subcommand or flag). The `fx` here is a
 * fake shell script that records argv and stdin; the real binary never runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  cleanupFakeDirs,
  collect,
  FX_ASK_NETWORK_ON,
  fakeFx,
  makeRequest,
  recordingSpawn,
} from "./helpers.js";

afterEach(cleanupFakeDirs);

function run(driver: FxCliDriver, input: string, instruction?: string) {
  return collect(
    driver.run(
      makeRequest(FX_PROVIDER, {
        context: { input } as never,
        instruction,
        permissions: FX_ASK_NETWORK_ON,
      }),
    ),
  );
}

describe.skipIf(process.platform === "win32")("fx prompt on stdin", () => {
  for (const prompt of ["update", "--yolo", "-h", "--full-access", "ask"]) {
    test(`the prompt ${JSON.stringify(prompt)} reaches fx only on stdin`, async () => {
      const fake = fakeFx();
      const events = await run(
        new FxCliDriver(
          baseConfig({
            command: fake.command,
            env: { PATH: "/usr/bin:/bin" },
          }),
        ),
        prompt,
      );
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
      expect(fake.stdin()).toBe(prompt);
      const argv = fake.argv();
      expect(argv).not.toContain(prompt === "ask" ? "update" : prompt);
      expect(argv.filter((arg) => arg === "ask")).toHaveLength(1);
      expect(argv.slice(0, 5)).toEqual([
        "ask",
        "--json",
        "--no-save",
        "--no-color",
        "--model",
      ]);
      expect(argv).not.toContain("--system");
      expect(argv).not.toContain("--yolo");
    });
  }

  test("the instruction goes inside the stdin prompt, before the user turn", async () => {
    const fake = fakeFx();
    await run(
      new FxCliDriver(baseConfig({ command: fake.command })),
      "list the files",
      "Be brief.",
    );
    expect(fake.stdin()).toBe("Be brief.\n\nlist the files");
    expect(fake.argv()).not.toContain("--system");
    expect(fake.argv()).not.toContain("Be brief.");
  });

  test("the spawn option input carries the prompt", async () => {
    const recorder = recordingSpawn();
    await run(
      new FxCliDriver(baseConfig({ spawn: recorder.spawn })),
      "update",
      "Be brief.",
    );
    expect(recorder.calls[0]?.options.input).toBe("Be brief.\n\nupdate");
    expect(recorder.calls[0]?.args).not.toContain("update");
  });
});
