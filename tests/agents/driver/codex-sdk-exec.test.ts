/**
 * The contained Codex exec copies `@openai/codex-sdk` 0.167.0 internals. These
 * tests pin that version, check that the copy sends the argv and env the SDK
 * sends, and check how `CodexSdkDriver` installs it and fails closed when it
 * cannot.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Codex } from "@openai/codex-sdk";
import {
  CODEX_SDK_INPUT_NOT_DELIVERED,
  CODEX_SDK_UNCONTAINED,
  CONTAINED_CODEX_SDK_VERSION,
  CodexSdkInputError,
  ContainedCodexExec,
  containCodexSdkClient,
  installedCodexSdkVersion,
  SUPPORTED_CODEX_SDK_VERSIONS,
} from "../../../src/agents/driver/codex-sdk-exec.js";
import { EXTERNAL_AGENT_DEPENDENCY_MISSING } from "../../../src/agents/driver/policy-errors.js";
import {
  CODEX_PROVIDER,
  CodexSdkDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";

// Each version-host case starts a Bun process that loads the driver.
const HOST_TIMEOUT_MS = 30_000;

describe("the Codex SDK version the containment copies", () => {
  test("is the installed @openai/codex-sdk (a bump must re-review the copy)", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dir,
          "../../../node_modules/@openai/codex-sdk/package.json",
        ),
        "utf8",
      ),
    ) as { version: string };
    const mismatch =
      manifest.version === CONTAINED_CODEX_SDK_VERSION
        ? []
        : [
            `@openai/codex-sdk is ${manifest.version}, the contained exec copies ${CONTAINED_CODEX_SDK_VERSION}: re-review the copied CodexExec.run in src/agents/driver/codex-sdk-exec.ts against the new SDK, then add the version to SUPPORTED_CODEX_SDK_VERSIONS`,
          ];
    expect(mismatch).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")(
  "ContainedCodexExec sends what the SDK's own exec sends",
  () => {
    let dir = "";
    let stub = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "codex-exec-parity-"));
      stub = join(dir, "codex");
      // A literal script: it reads the prompt like the real CLI, then
      // records its argv and env in the files the environment names.
      writeFileSync(
        stub,
        '#!/bin/sh\ncat > /dev/null\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done > "$ARGV_FILE"\nenv > "$ENV_FILE"\n',
      );
      chmodSync(stub, 0o755);
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    interface Case {
      name: string;
      options: Record<string, unknown>;
      thread: Record<string, unknown>;
      resume?: string;
      input: string | { type: string; text?: string; path?: string }[];
      outputSchema?: unknown;
    }

    const cases: Case[] = [
      {
        name: "every thread option, config objects and raw overrides",
        options: {
          baseUrl: "https://codex.invalid/v1",
          apiKey: "test-key",
          config: {
            a: 1,
            nested: { deep: { key: "v" }, list: [1, "two", true] },
            empty: {},
            "dotted.key": true,
            inline: [{ "quoted key": "x", n: 2 }],
          },
          configOverrides: ["mcp_servers.x.enabled=false", "b=2"],
        },
        thread: {
          model: "gpt-test",
          threadSource: "bridge",
          sandboxMode: "workspace-write",
          workingDirectory: "/work",
          additionalDirectories: ["/extra/one", "/extra/two"],
          skipGitRepoCheck: true,
          modelReasoningEffort: "high",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          approvalPolicy: "never",
        },
        input: "hello",
        outputSchema: { type: "object", properties: {} },
      },
      {
        name: "a resumed thread with images, network on and live search",
        options: {},
        thread: {
          networkAccessEnabled: true,
          webSearchEnabled: true,
          threadSource: "ignored-on-resume",
        },
        resume: "thread-123",
        input: [
          { type: "text", text: "look" },
          { type: "local_image", path: "/img/a.png" },
          { type: "local_image", path: "/img/b.png" },
        ],
      },
      {
        name: "search off by the boolean",
        options: { config: {} },
        thread: { webSearchEnabled: false },
        input: "x",
      },
    ];

    async function record(
      testCase: Case,
      contain: boolean,
    ): Promise<{ argv: string[]; env: string[] }> {
      const tag = contain ? "contained" : "sdk";
      const argvFile = join(dir, `${tag}.argv`);
      const envFile = join(dir, `${tag}.env`);
      const client = new Codex({
        ...testCase.options,
        codexPathOverride: stub,
        env: {
          PATH: "/usr/bin:/bin",
          ARGV_FILE: argvFile,
          ENV_FILE: envFile,
        },
      } as never);
      if (contain) {
        expect(containCodexSdkClient(client)).toBe("contained");
      }
      const thread = testCase.resume
        ? client.resumeThread(testCase.resume, testCase.thread as never)
        : client.startThread(testCase.thread as never);
      await thread
        .run(testCase.input as never, { outputSchema: testCase.outputSchema })
        .catch(() => undefined);
      const argv = readFileSync(argvFile, "utf8").split("\n");
      // The schema file is a fresh temporary path per run.
      const schemaAt = argv.indexOf("--output-schema");
      if (schemaAt >= 0) argv[schemaAt + 1] = "<schema>";
      const env = readFileSync(envFile, "utf8")
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("ARGV_FILE=") &&
            !line.startsWith("ENV_FILE=") &&
            // Set by the shell itself.
            !line.startsWith("PWD=") &&
            !line.startsWith("SHLVL=") &&
            !line.startsWith("_="),
        )
        .sort();
      return { argv, env };
    }

    for (const testCase of cases) {
      test(testCase.name, async () => {
        const sdk = await record(testCase, false);
        const contained = await record(testCase, true);
        expect(sdk.argv.length).toBeGreaterThan(3);
        expect(contained.argv).toEqual(sdk.argv);
        expect(contained.env).toEqual(sdk.env);
      });
    }
  },
);

describe("containCodexSdkClient", () => {
  test("replaces the exec of an SDK client once", () => {
    const client = new Codex({ codexPathOverride: "/opt/codex" });
    expect(containCodexSdkClient(client)).toBe("contained");
    const exec = (client as unknown as { exec: unknown }).exec;
    expect(exec).toBeInstanceOf(ContainedCodexExec);
    expect((exec as ContainedCodexExec).executablePath).toBe("/opt/codex");
    expect(containCodexSdkClient(client)).toBe("contained");
    expect((client as unknown as { exec: unknown }).exec).toBe(exec);
  });

  test("leaves an object with no SDK exec as is", () => {
    const fake = { startThread() {}, resumeThread() {} };
    expect(containCodexSdkClient(fake)).toBe("not-sdk");
    expect(containCodexSdkClient({ exec: {} })).toBe("not-sdk");
    expect(containCodexSdkClient(null)).toBe("not-sdk");
  });

  test("reports an exec that lacks any one field of SDK 0.167.0", () => {
    const fields = {
      executablePath: "/opt/codex",
      pathDirs: [],
      envOverride: undefined,
      configOverrides: undefined,
      rawConfigOverrides: undefined,
    };
    for (const missing of Object.keys(fields)) {
      const exec: Record<string, unknown> = { run() {}, ...fields };
      delete exec[missing];
      expect([missing, containCodexSdkClient({ exec })]).toEqual([
        missing,
        "unknown-shape",
      ]);
    }
  });

  test("reports an exec whose fields differ from SDK 0.167.0", () => {
    const client = { exec: { run() {}, executablePath: "/opt/codex" } };
    expect(containCodexSdkClient(client)).toBe("unknown-shape");
    expect(client.exec).not.toBeInstanceOf(ContainedCodexExec);
  });
});

function request(): ExternalAgentRunRequest {
  return {
    provider: CODEX_PROVIDER,
    agent: { name: "codex" } as never,
    context: {
      agent: { name: "codex" },
      session: { state: {}, events: [] },
      userContent: { role: "user", parts: [{ text: "go" }] },
    } as never,
    permissions: { mode: "read-only", allowNetwork: true },
  };
}

async function drain(driver: CodexSdkDriver): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(request())) events.push(event);
  return events;
}

const execFields = {
  executablePath: "/opt/codex",
  pathDirs: [],
  envOverride: undefined,
  configOverrides: undefined,
  rawConfigOverrides: undefined,
};

describe("CodexSdkDriver and the contained exec", () => {
  test("refuses a client whose exec it cannot contain, before any turn", async () => {
    let started = 0;
    const events = await drain(
      new CodexSdkDriver({
        sdk: {
          exec: { run() {} },
          startThread: () => {
            started++;
            return {} as never;
          },
          resumeThread: () => ({}) as never,
        } as never,
      }),
    );
    expect(started).toBe(0);
    const error = events.find((event) => event.type === "error");
    expect(error && "code" in error ? error.code : undefined).toBe(
      EXTERNAL_AGENT_DEPENDENCY_MISSING,
    );
  });

  test("refuses a thread that does not run its turns through the contained exec", async () => {
    let turns = 0;
    const client = {
      exec: { run() {}, ...execFields },
      startThread: () => ({
        _exec: { run() {} },
        runStreamed: async () => {
          turns++;
          return { events: (async function* () {})() };
        },
      }),
      resumeThread: () => ({}) as never,
    };
    const events = await drain(new CodexSdkDriver({ sdk: client as never }));
    expect(turns).toBe(0);
    const error = events.find((event) => event.type === "error");
    expect(error && "code" in error ? error.code : undefined).toBe(
      EXTERNAL_AGENT_DEPENDENCY_MISSING,
    );
  });

  test("runs a thread that uses the contained exec", async () => {
    let turns = 0;
    const client: Record<string, unknown> = {
      exec: { run() {}, ...execFields },
      resumeThread: () => ({}) as never,
    };
    client.startThread = () => ({
      _exec: client.exec,
      runStreamed: async () => {
        turns++;
        return {
          events: (async function* () {
            yield { type: "turn.completed", usage: { input_tokens: 1 } };
          })(),
        };
      },
    });
    const events = await drain(new CodexSdkDriver({ sdk: client as never }));
    expect(turns).toBe(1);
    expect(client.exec).toBeInstanceOf(ContainedCodexExec);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  test("reports an undelivered prompt with its own code, not by its message", async () => {
    const thread = {
      runStreamed: async () => {
        // The message names a transport error, which the message heuristics
        // would classify as TRANSPORT_ERROR (recoverable).
        throw new CodexSdkInputError(
          "Codex did not read the prompt from stdin (the write failed with ECONNRESET); it exited with code 0: ",
        );
      },
    };
    const events = await drain(
      new CodexSdkDriver({
        sdk: {
          startThread: () => thread as never,
          resumeThread: () => thread as never,
        },
      }),
    );
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({
      code: CODEX_SDK_INPUT_NOT_DELIVERED,
      recoverable: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });
});

describe("the installed SDK version at run time", () => {
  let stubDir = "";
  let normalStub = "";
  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), "codex-sdk-version-"));
    normalStub = join(stubDir, "codex");
    writeFileSync(
      normalStub,
      '#!/bin/sh\ncat > /dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"t-1"}\' \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\'\n',
    );
    chmodSync(normalStub, 0o755);
  });
  afterAll(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  test("is read from the resolved package", () => {
    expect(installedCodexSdkVersion()).toBe(CONTAINED_CODEX_SDK_VERSION);
    expect(SUPPORTED_CODEX_SDK_VERSIONS).toEqual([CONTAINED_CODEX_SDK_VERSION]);
  });

  test("another version is reported before the shape of its exec", () => {
    // A later SDK may change the exec's fields; the option to run it
    // uncontained must still apply.
    expect(
      containCodexSdkClient({ exec: { run() {} } }, { sdkVersion: "0.168.0" }),
    ).toBe("unsupported-version");
    expect(
      containCodexSdkClient(
        { exec: { run() {} } },
        { sdkVersion: CONTAINED_CODEX_SDK_VERSION },
      ),
    ).toBe("unknown-shape");
  });

  test("an SDK client on another version is not contained", () => {
    for (const sdkVersion of ["0.167.1", "0.168.0", undefined]) {
      const client = new Codex({ codexPathOverride: "/opt/codex" });
      expect([
        sdkVersion,
        containCodexSdkClient(client, { sdkVersion }),
      ]).toEqual([sdkVersion, "unsupported-version"]);
      expect((client as unknown as { exec: unknown }).exec).not.toBeInstanceOf(
        ContainedCodexExec,
      );
    }
  });

  for (const [installed, shown] of [
    ["0.167.1", "installed: 0.167.1"],
    ["none", "installed: a version the driver could not read"],
  ] as const) {
    test(
      `CodexSdkDriver refuses SDK ${installed} before codex starts, naming both ways forward`,
      () => {
        const report = runVersionHost([installed]);
        expect(report.turns).toBe(0);
        expect(report.codes).toEqual([EXTERNAL_AGENT_DEPENDENCY_MISSING]);
        expect(report.message).toContain("@openai/codex-sdk 0.167.0");
        expect(report.message).toContain(shown);
        expect(report.message).toContain(
          "npm install @openai/codex-sdk@0.167.0",
        );
        expect(report.message).toContain("allowUncontainedCodexSdk: true");
        expect(report.message).toContain("new CodexCliDriver(...)");
        expect(report.warnings).toEqual([]);
      },
      HOST_TIMEOUT_MS,
    );
  }

  test(
    "allowUncontainedCodexSdk on another version runs the SDK's own exec, with one warning per driver",
    () => {
      const report = runVersionHost(["0.168.0", "allow", normalStub, "2"]);
      expect(report.codes).toEqual([]);
      expect(report.exitCodes).toEqual([0, 0]);
      expect(report.turns).toBe(2);
      expect(report.execRuns).toBe(2);
      expect(report.sameExec).toBe(true);
      expect(report.contained).toBe(false);
      expect(report.warnings).toEqual([CODEX_SDK_UNCONTAINED]);
    },
    HOST_TIMEOUT_MS,
  );

  test(
    "allowUncontainedCodexSdk set to a truthy value other than true does not enable it",
    () => {
      const report = runVersionHost(["0.168.0", "truthy", normalStub]);
      expect(report.turns).toBe(0);
      expect(report.execRuns).toBe(0);
      expect(report.codes).toEqual([EXTERNAL_AGENT_DEPENDENCY_MISSING]);
      expect(report.warnings).toEqual([]);
    },
    HOST_TIMEOUT_MS,
  );

  test(
    "allowUncontainedCodexSdk on 0.167.0 still runs the contained exec, with no warning",
    () => {
      const report = runVersionHost(["0.167.0", "allow", normalStub, "2"]);
      expect(report.codes).toEqual([]);
      expect(report.exitCodes).toEqual([0, 0]);
      expect(report.execRuns).toBe(0);
      expect(report.contained).toBe(true);
      expect(report.warnings).toEqual([]);
    },
    HOST_TIMEOUT_MS,
  );

  test("allowUncontainedCodexSdk on 0.167.0 still refuses an exec it cannot contain", async () => {
    let started = 0;
    const events = await drain(
      new CodexSdkDriver({
        allowUncontainedCodexSdk: true,
        sdk: {
          exec: { run() {} },
          startThread: () => {
            started++;
            return {} as never;
          },
          resumeThread: () => ({}) as never,
        } as never,
      }),
    );
    expect(started).toBe(0);
    const error = events.find((event) => event.type === "error");
    expect(error && "code" in error ? error.code : undefined).toBe(
      EXTERNAL_AGENT_DEPENDENCY_MISSING,
    );
  });
});

interface VersionHostReport {
  codes: string[];
  message?: string;
  turns: number;
  execRuns: number;
  exitCodes: number[];
  warnings: string[];
  contained: boolean;
  sameExec: boolean;
}

/** Runs `fixtures/codex-sdk-version-host.ts` with `args`. */
function runVersionHost(args: string[]): VersionHostReport {
  const host = spawnSync(
    process.execPath,
    [resolve(import.meta.dir, "fixtures/codex-sdk-version-host.ts"), ...args],
    { encoding: "utf8", timeout: 20_000 },
  );
  const line = host.stdout.trim().split("\n").at(-1) ?? "";
  if (!line.startsWith("{")) {
    throw new Error(
      `version host died (status ${host.status}): ${host.stderr.slice(-2000)}`,
    );
  }
  return JSON.parse(line) as VersionHostReport;
}

/** A child process whose events a test fires in a chosen order. */
function scriptedChild() {
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: () => true,
    end: () => undefined,
    destroy() {
      stdin.destroyed = true;
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    kill: () => true,
  });
  const exit = (code: number) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  return { child, stdin, exit };
}

const scriptedFields = {
  executablePath: "/opt/codex",
  pathDirs: [],
  envOverride: { PATH: "/usr/bin:/bin" },
  configOverrides: undefined,
  rawConfigOverrides: undefined,
};

async function runScripted(
  script: (scripted: ReturnType<typeof scriptedChild>) => Promise<void> | void,
): Promise<{ lines: string[]; error?: unknown; settledMs: number }> {
  const scripted = scriptedChild();
  const exec = new ContainedCodexExec(scriptedFields, {
    spawn: () => scripted.child as never,
  });
  const lines: string[] = [];
  let stdoutEndedAt = 0;
  scripted.child.stdout.on("end", () => {
    stdoutEndedAt = Date.now();
  });
  const turn = (async () => {
    for await (const line of exec.run({ input: "hi" })) lines.push(line);
  })();
  await new Promise((done) => setTimeout(done, 10));
  await script(scripted);
  let error: unknown;
  try {
    await turn;
  } catch (caught) {
    error = caught;
  }
  return { lines, error, settledMs: Date.now() - stdoutEndedAt };
}

describe("ContainedCodexExec input settle (scripted child)", () => {
  test("a finish after the exit is waited for: the turn succeeds", async () => {
    const { lines, error } = await runScripted(({ child, stdin, exit }) => {
      child.stdout.write('{"type":"thread.started","thread_id":"t"}\n');
      exit(0);
      child.stdout.end();
      setTimeout(() => stdin.emit("finish"), 50);
    });
    expect(error).toBeUndefined();
    expect(lines).toEqual(['{"type":"thread.started","thread_id":"t"}']);
  });

  test("no finish and no error after the exit: not delivered, stdin destroyed", async () => {
    let destroyed = false;
    const { error, settledMs } = await runScripted(({ child, stdin, exit }) => {
      exit(0);
      child.stdout.end();
      setTimeout(() => {
        destroyed = stdin.destroyed;
      }, 1_500);
    });
    expect(error).toBeInstanceOf(CodexSdkInputError);
    expect((error as CodexSdkInputError).code).toBe(
      CODEX_SDK_INPUT_NOT_DELIVERED,
    );
    expect(settledMs).toBeGreaterThanOrEqual(900);
    await new Promise((done) => setTimeout(done, 1_600));
    expect(destroyed).toBe(true);
  });

  test("a finish before the exit: the turn ends with no wait", async () => {
    const { error, settledMs } = await runScripted(({ child, stdin, exit }) => {
      stdin.emit("finish");
      exit(0);
      child.stdout.end();
    });
    expect(error).toBeUndefined();
    expect(settledMs).toBeLessThan(100);
  });
});
