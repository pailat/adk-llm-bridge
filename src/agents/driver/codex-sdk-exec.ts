/*!
 * Adapted from @openai/codex-sdk 0.167.0 (https://github.com/openai/codex,
 * sdk/typescript/src/exec.ts: CodexExec.run and the config, TOML and PATH
 * helpers it calls). Copyright 2025 OpenAI.
 * @license Apache-2.0 (full text in THIRD-PARTY-NOTICES).
 * Modified by adk-llm-bridge: an error listener on the child's stdin that
 * stays after the turn; a kill when stdin fails while the child runs; a wait
 * of at most 1 s for the prompt write to settle after the exit; a typed
 * error for a prompt the child did not read and for a non-zero exit; a
 * no-op child error listener after the cleanup; an injectable spawn; the
 * turn ends at once when the spawn fails; error listeners on the child's
 * stdout and stderr; the stdout read ends after the child exited (the
 * spawn layer's post-exit drain rule); SIGKILL after a grace when SIGTERM is
 * ignored.
 */

/**
 * A contained copy of the `@openai/codex-sdk` 0.167.0 exec path.
 *
 * The SDK writes the prompt to the child's stdin with no `error` listener on
 * that stream. When the child is gone before it has read the whole prompt
 * (it exited early, was aborted, or closed stdin) the write fails with
 * `EPIPE` as an uncaught exception, which ends the host process. The SDK has
 * no option or hook that reaches the child, so the driver replaces the
 * client's exec, per client, with {@link ContainedCodexExec}: the same argv,
 * env and spawn options, plus a stdin error listener. It does so only on the
 * SDK versions in {@link SUPPORTED_CODEX_SDK_VERSIONS}.
 *
 * The copy is temporary: it stays until `@openai/codex-sdk` handles stdin
 * errors itself, and is removed once an SDK version with that fix is
 * verified (the fault tests pass on it without the copy).
 *
 * This module imports only `node:` modules, so it also runs under Node's
 * type stripping (the fault tests load it that way).
 */

import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DEFAULT_KILL_GRACE_MS, drainAfterExit } from "./spawn.js";

/**
 * The `@openai/codex-sdk` version whose exec path this module copies. A test
 * fails when the installed SDK differs, so a bump re-reviews the copy.
 */
export const CONTAINED_CODEX_SDK_VERSION = "0.167.0";

/**
 * The `@openai/codex-sdk` versions the contained exec was copied from and
 * checked against. The driver refuses an SDK client on any other version.
 */
export const SUPPORTED_CODEX_SDK_VERSIONS: readonly string[] = [
  CONTAINED_CODEX_SDK_VERSION,
];

/** Starts the child; `node:child_process` `spawn` unless a test injects one. */
export type CodexExecSpawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; signal?: AbortSignal },
) => ChildProcess;

/**
 * The warning code `CodexSdkDriver` logs, once per driver, when
 * `allowUncontainedCodexSdk` makes it run an SDK version it cannot contain.
 */
export const CODEX_SDK_UNCONTAINED = "CODEX_SDK_UNCONTAINED";

/** The driver error code for a non-zero exit of the Codex process. */
export const CODEX_SDK_ERROR = "CODEX_SDK_ERROR";

/** The driver error code for a prompt the Codex process did not read. */
export const CODEX_SDK_INPUT_NOT_DELIVERED = "CODEX_SDK_INPUT_NOT_DELIVERED";

/** How long to wait for stdin to settle after the child exited. */
const INPUT_SETTLE_MS = 1_000;

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const TYPESCRIPT_SDK_ORIGINATOR = "codex_sdk_ts";

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

/** The arguments `Thread` passes to `exec.run` in SDK 0.167.0. */
export interface CodexExecArgs {
  input: string;
  baseUrl?: string;
  apiKey?: string;
  threadId?: string | null;
  images?: string[];
  model?: string;
  threadSource?: string;
  sandboxMode?: string;
  workingDirectory?: string;
  additionalDirectories?: string[];
  skipGitRepoCheck?: boolean;
  outputSchemaFile?: string;
  cyberAccessProgram?: string;
  modelReasoningEffort?: string;
  signal?: AbortSignal;
  networkAccessEnabled?: boolean;
  webSearchMode?: string;
  webSearchEnabled?: boolean;
  approvalPolicy?: string;
}

/** The fields of the SDK's `CodexExec` instance the copy reads. */
interface CodexExecFields {
  executablePath: string;
  pathDirs: string[];
  envOverride?: Record<string, string>;
  configOverrides?: { [key: string]: CodexConfigValue };
  rawConfigOverrides?: string[];
}

/**
 * The Codex process did not read the whole prompt from stdin: it exited
 * first, closed stdin, or a grandchild kept the pipe without reading it.
 * The message carries the exit detail and stderr, which usually say why.
 */
export class CodexSdkInputError extends Error {
  /** Always {@link CODEX_SDK_INPUT_NOT_DELIVERED}. */
  readonly code = CODEX_SDK_INPUT_NOT_DELIVERED;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexSdkInputError";
  }
}

/**
 * The Codex process exited non-zero or by a signal on its own. The message
 * is the SDK's (`Codex Exec exited with ...: <stderr>`); the code lets a
 * caller tell it apart without reading the message.
 */
export class CodexSdkExitError extends Error {
  /** Always {@link CODEX_SDK_ERROR}. */
  readonly code = CODEX_SDK_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "CodexSdkExitError";
  }
}

/**
 * The SDK's exec path with the prompt write contained.
 *
 * @remarks
 * Built from the SDK's own exec instance, so the binary (`executablePath`,
 * the driver's resolved `codexPathOverride`), the env (`envOverride`, the
 * driver's scrubbed env) and the `--config` overrides are the ones the SDK
 * would use. The argv is built exactly as SDK 0.167.0 builds it.
 */
export class ContainedCodexExec {
  readonly executablePath: string;
  readonly pathDirs: string[];
  readonly envOverride: Record<string, string> | undefined;
  readonly configOverrides: { [key: string]: CodexConfigValue } | undefined;
  readonly rawConfigOverrides: string[] | undefined;

  readonly #spawn: CodexExecSpawn;
  readonly #killGraceMs: number;

  /**
   * @param source - The SDK's own exec instance (its fields are copied).
   * @param options - `spawn` replaces `node:child_process` `spawn`, for
   * tests that script the child's events. `killGraceMs` is how long a
   * stopped child gets to exit after SIGTERM before it gets SIGKILL.
   * @defaultValue `killGraceMs` is {@link DEFAULT_KILL_GRACE_MS}.
   */
  constructor(
    source: CodexExecFields,
    options: { spawn?: CodexExecSpawn; killGraceMs?: number } = {},
  ) {
    this.#spawn = options.spawn ?? nodeSpawn;
    this.#killGraceMs =
      typeof options.killGraceMs === "number" &&
      Number.isFinite(options.killGraceMs) &&
      options.killGraceMs >= 0
        ? options.killGraceMs
        : DEFAULT_KILL_GRACE_MS;
    this.executablePath = source.executablePath;
    this.pathDirs = [...source.pathDirs];
    this.envOverride = source.envOverride;
    this.configOverrides = source.configOverrides;
    this.rawConfigOverrides = source.rawConfigOverrides;
  }

  /**
   * Runs one `codex exec` turn and yields its stdout lines.
   *
   * @param args - What `Thread` passes for the turn.
   * @returns The JSONL lines Codex prints. The stream ends when the child's
   * stdout reaches EOF, or, once the child has exited, when a wait on stdout
   * stays unanswered for two idle windows of 500 ms. Output not yet read is
   * never dropped. A grandchild that still holds the pipe no longer blocks
   * the turn after those windows, but this rule does not kill it and any
   * output it writes later is not read. A child that was stopped (cleanup,
   * abort, a failed stdin) and ignores SIGTERM gets SIGKILL after the kill
   * grace.
   * @throws The spawn error as soon as the spawn fails (the turn does not
   * wait for an exit that never comes); the `error` of the child's stdout;
   * the abort error when `args.signal` aborts the turn; else the
   * SDK's own error for a non-zero exit of the child's own; else a
   * {@link CodexSdkInputError} when the prompt was not read (the child closed
   * stdin and was stopped, or exited 0 without reading it).
   */
  async *run(args: CodexExecArgs): AsyncGenerator<string> {
    const commandArgs = codexExecArgv(this, args);
    const env = codexExecEnv(this, args);
    const child = this.#spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
    });
    let spawnError: Error | null = null;
    let outputError: Error | null = null;
    let rl: readline.Interface | undefined;
    // Neither runtime ends the child's stdout when the spawn fails (Bun
    // never does), so the error itself ends the read.
    child.once("error", (err) => {
      spawnError = err;
      rl?.close();
    });
    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    const stdin = child.stdin;
    // Contained: the SDK has no listener here, so a write to a child that
    // is gone ends the host. The listener stays after the turn, so a late
    // error (after the cleanup below kills the child) is swallowed too.
    let inputError: Error | undefined;
    let inputDone = false;
    let killedForInput = false;
    let settleInput: () => void = () => {};
    const inputSettled = new Promise<void>((resolve) => {
      settleInput = resolve;
    });
    stdin.on("error", (err) => {
      inputError ??= err;
      settleInput();
      // A child that closed stdin and keeps running would wait forever for
      // a prompt it will never get.
      if (child.exitCode === null && child.signalCode === null) {
        killedForInput = true;
        try {
          child.kill();
        } catch {
          // Reported by the child's `error` event.
        }
        escalate();
      }
    });
    stdin.once("finish", () => {
      inputDone = true;
      settleInput();
    });
    stdin.once("close", () => settleInput());
    stdin.write(args.input);
    stdin.end();
    if (!child.stdout) {
      child.kill();
      throw new Error("Child process has no stdout");
    }
    const stderrChunks: Buffer[] = [];
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderrChunks.push(data);
      });
      // Contained: an uncaught stream error ends the host. The turn reports
      // how the process ended, so a stderr error is not one of its outcomes.
      child.stderr.on("error", () => {});
    }
    // Contained: the same for stdout, whose error ends the turn.
    child.stdout.on("error", (err) => {
      outputError ??= err;
      // Later than the interface's own forwarding of this error, which
      // needs the interface open.
      queueMicrotask(() => rl?.close());
    });
    const stdout = child.stdout;
    // The spawn layer's rule: after the exit, stdout is read until EOF or
    // until it stays idle, then the read ends.
    const drain = drainAfterExit(
      () => rl?.close(),
      () => !stdout.isPaused() && stdout.readableLength === 0,
    );
    stdout.on("data", () => drain.activity());
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => {
        drain.start();
        resolve({ code, signal });
      });
    });
    // SIGTERM is not enough for a child that ignores it: it never exits, and
    // the drain above never starts.
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const escalate = () => {
      // Armed once per turn.
      if (escalation !== undefined) return;
      escalation = setTimeout(() => {
        escalation = undefined;
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child is gone.
          }
        }
      }, this.#killGraceMs);
      escalation.unref?.();
    };
    const clearEscalation = () => {
      if (escalation !== undefined) {
        clearTimeout(escalation);
        escalation = undefined;
      }
    };
    args.signal?.addEventListener("abort", escalate, { once: true });
    rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    if (spawnError || outputError) rl.close();
    try {
      for await (const line of rl) {
        yield line;
      }
      if (spawnError) throw spawnError;
      if (outputError) throw outputError;
      const { code, signal } = await exitPromise;
      // An abort was thrown above as the SDK throws it. Wait for the prompt
      // write to settle, so an EPIPE that arrives just after the exit is
      // seen, and a `finish` that arrives after it is not taken for a loss.
      const delivered = await settled(inputSettled, () => inputDone);
      if (!delivered) stdin.destroy();
      const stderr = () => Buffer.concat(stderrChunks).toString("utf8");
      // A non-zero exit of the child's own explains itself (stderr usually
      // says why it stopped before reading), as the SDK reports it. A kill
      // for the input failure ends the child by signal; an exit code means
      // it had exited on its own (its EPIPE can arrive before its exit).
      const stoppedForInput = killedForInput && code === null;
      if ((code !== 0 || signal) && !stoppedForInput) {
        throw new CodexSdkExitError(
          `Codex Exec exited with ${exitDetail(code, signal)}: ${stderr()}`,
        );
      }
      if (!delivered) {
        const reason = inputError
          ? `the write failed with ${errorCode(inputError)}`
          : "it was not read";
        const after = stoppedForInput
          ? "the bridge stopped the process"
          : `it exited with ${exitDetail(code, signal)}`;
        throw new CodexSdkInputError(
          `Codex did not read the prompt from stdin (${reason}); ${after}: ${stderr()}`,
          { cause: inputError },
        );
      }
    } finally {
      drain.cancel();
      args.signal?.removeEventListener("abort", escalate);
      rl.close();
      child.removeAllListeners();
      // Contained: `removeAllListeners` also drops the runtime's own `exit`
      // listener that unhooks the abort listener it put on `signal`. After
      // an early return the child may still run, so a later abort kills it
      // again and emits an `AbortError` on the child, which must not end the
      // host.
      child.on("error", () => {});
      try {
        if (!child.killed) child.kill();
      } catch {
        // The child is gone.
      }
      if (child.exitCode === null && child.signalCode === null) {
        // `removeAllListeners` above dropped the exit listener of the
        // escalation, so it is set again here.
        escalate();
        child.once("exit", clearEscalation);
      }
    }
  }
}

/**
 * The version of the `@openai/codex-sdk` package this module resolves, read
 * once per process from its `package.json` (the package's `exports` map does
 * not export that file, so it is read from beside the resolved entry).
 *
 * @returns The version, or `undefined` when the package cannot be resolved
 * or read.
 */
export function installedCodexSdkVersion(): string | undefined {
  if (installedVersion === undefined) {
    installedVersion = { value: readInstalledVersion() };
  }
  return installedVersion.value;
}

let installedVersion: { value: string | undefined } | undefined;

function readInstalledVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
    const manifest = JSON.parse(
      readFileSync(join(dirname(entry), "..", "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    return manifest.name === "@openai/codex-sdk" &&
      typeof manifest.version === "string"
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the exec of a `@openai/codex-sdk` client with a
 * {@link ContainedCodexExec}, so the turns of threads started or resumed
 * from it afterwards cannot end the host with an `EPIPE`.
 *
 * @param client - A `Codex` client, or any object (left as is when it has
 * no exec with a `run` function, such as a test double).
 * @param options - `sdkVersion` is the installed SDK version; it defaults to
 * {@link installedCodexSdkVersion}.
 * @returns `"contained"` when the client's exec is contained (now or
 * before); `"not-sdk"` when the client has no SDK exec;
 * `"unsupported-version"` when the SDK version is not in
 * {@link SUPPORTED_CODEX_SDK_VERSIONS} or cannot be read; `"unknown-shape"`
 * when the version is supported but the exec's fields differ from SDK
 * 0.167.0. On the last two the client is left as is, and its exec is not
 * contained.
 */
export function containCodexSdkClient(
  client: unknown,
  options: { sdkVersion?: string | undefined } = {},
): "contained" | "not-sdk" | "unknown-shape" | "unsupported-version" {
  if (typeof client !== "object" || client === null) return "not-sdk";
  const exec = (client as { exec?: unknown }).exec;
  if (exec instanceof ContainedCodexExec) return "contained";
  if (
    typeof exec !== "object" ||
    exec === null ||
    typeof (exec as { run?: unknown }).run !== "function"
  ) {
    return "not-sdk";
  }
  const version =
    "sdkVersion" in options ? options.sdkVersion : installedCodexSdkVersion();
  if (
    version === undefined ||
    !SUPPORTED_CODEX_SDK_VERSIONS.includes(version)
  ) {
    return "unsupported-version";
  }
  if (!isCodexExecShape(exec)) return "unknown-shape";
  (client as { exec: unknown }).exec = new ContainedCodexExec(exec);
  return "contained";
}

/**
 * Whether a thread runs its turns through `exec` (SDK 0.167.0 keeps it in
 * the thread's `_exec`).
 *
 * @param thread - A thread from `startThread` or `resumeThread`.
 * @param exec - The client's contained exec.
 * @returns `true` when the thread uses it.
 */
export function threadUsesExec(thread: unknown, exec: unknown): boolean {
  return (
    typeof thread === "object" &&
    thread !== null &&
    (thread as { _exec?: unknown })._exec === exec
  );
}

function isCodexExecShape(exec: object): exec is CodexExecFields {
  const fields = exec as Record<string, unknown>;
  return (
    typeof fields.executablePath === "string" &&
    Array.isArray(fields.pathDirs) &&
    fields.pathDirs.every((dir) => typeof dir === "string") &&
    "envOverride" in fields &&
    "configOverrides" in fields &&
    "rawConfigOverrides" in fields
  );
}

async function settled(
  input: Promise<void>,
  done: () => boolean,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, INPUT_SETTLE_MS);
  });
  try {
    await Promise.race([input, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return done();
}

function errorCode(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error.message;
}

function exitDetail(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return signal ? `signal ${signal}` : `code ${code ?? 1}`;
}

/** The argv SDK 0.167.0 builds for one turn (`CodexExec.run`). */
export function codexExecArgv(
  exec: CodexExecFields,
  args: CodexExecArgs,
): string[] {
  const commandArgs = ["exec", "--experimental-json"];
  if (exec.configOverrides) {
    for (const override of serializeConfigOverrides(exec.configOverrides)) {
      commandArgs.push("--config", override);
    }
  }
  if (exec.rawConfigOverrides) {
    for (const override of exec.rawConfigOverrides) {
      commandArgs.push("--config", override);
    }
  }
  if (args.baseUrl) {
    commandArgs.push(
      "--config",
      `openai_base_url=${toTomlValue(args.baseUrl, "openai_base_url")}`,
    );
  }
  if (args.model) {
    commandArgs.push("--model", args.model);
  }
  if (args.threadSource !== undefined && !args.threadId) {
    commandArgs.push("--thread-source", args.threadSource);
  }
  if (args.sandboxMode) {
    commandArgs.push("--sandbox", args.sandboxMode);
  }
  if (args.workingDirectory) {
    commandArgs.push("--cd", args.workingDirectory);
  }
  if (args.additionalDirectories?.length) {
    for (const dir of args.additionalDirectories) {
      commandArgs.push("--add-dir", dir);
    }
  }
  if (args.skipGitRepoCheck) {
    commandArgs.push("--skip-git-repo-check");
  }
  if (args.outputSchemaFile) {
    commandArgs.push("--output-schema", args.outputSchemaFile);
  }
  if (args.cyberAccessProgram !== undefined) {
    commandArgs.push("--cyber-access-program", args.cyberAccessProgram);
  }
  if (args.modelReasoningEffort) {
    commandArgs.push(
      "--config",
      `model_reasoning_effort="${args.modelReasoningEffort}"`,
    );
  }
  if (args.networkAccessEnabled !== undefined) {
    commandArgs.push(
      "--config",
      `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`,
    );
  }
  if (args.webSearchMode) {
    commandArgs.push("--config", `web_search="${args.webSearchMode}"`);
  } else if (args.webSearchEnabled === true) {
    commandArgs.push("--config", `web_search="live"`);
  } else if (args.webSearchEnabled === false) {
    commandArgs.push("--config", `web_search="disabled"`);
  }
  if (args.approvalPolicy) {
    commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
  }
  if (args.threadId) {
    commandArgs.push("resume", args.threadId);
  }
  if (args.images?.length) {
    for (const image of args.images) {
      commandArgs.push("--image", image);
    }
  }
  return commandArgs;
}

/** The env SDK 0.167.0 gives the child (`CodexExec.run`). */
export function codexExecEnv(
  exec: CodexExecFields,
  args: Pick<CodexExecArgs, "apiKey">,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (exec.envOverride) {
    Object.assign(env, exec.envOverride);
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }
  if (!env[INTERNAL_ORIGINATOR_ENV]) {
    env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
  }
  if (args.apiKey) {
    env.CODEX_API_KEY = args.apiKey;
  }
  if (exec.pathDirs.length > 0) {
    prependPathDirs(env, exec.pathDirs);
  }
  return env;
}

function serializeConfigOverrides(configOverrides: CodexConfigValue): string[] {
  const overrides: string[] = [];
  flattenConfigOverrides(configOverrides, "", overrides);
  return overrides;
}

function flattenConfigOverrides(
  value: CodexConfigValue | undefined,
  prefix: string,
  overrides: string[],
): void {
  if (!isPlainObject(value)) {
    if (prefix) {
      overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
      return;
    }
    throw new Error("Codex config overrides must be a plain object");
  }
  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) {
    return;
  }
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }
  for (const [key, child] of entries) {
    if (!key) {
      throw new Error("Codex config override keys must be non-empty strings");
    }
    if (child === undefined) {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child, path, overrides);
    } else {
      overrides.push(`${path}=${toTomlValue(child, path)}`);
    }
  }
}

function toTomlValue(value: unknown, path: string): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Codex config override at ${path} must be a finite number`,
      );
    }
    return `${value}`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    const rendered = value.map((item, index) =>
      toTomlValue(item, `${path}[${index}]`),
    );
    return `[${rendered.join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (!key) {
        throw new Error("Codex config override keys must be non-empty strings");
      }
      if (child === undefined) {
        continue;
      }
      parts.push(
        `${formatTomlKey(key)} = ${toTomlValue(child, `${path}.${key}`)}`,
      );
    }
    return `{${parts.join(", ")}}`;
  }
  if (value === null) {
    throw new Error(`Codex config override at ${path} cannot be null`);
  }
  throw new Error(
    `Unsupported Codex config override value at ${path}: ${typeof value}`,
  );
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function isPlainObject(
  value: unknown,
): value is { [key: string]: CodexConfigValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prependPathDirs(
  env: Record<string, string>,
  pathDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const pathKey = pathEnvKey(env, platform);
  if (platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path" && key !== pathKey) {
        delete env[key];
      }
    }
  }
  const existingEntries = (env[pathKey] ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !pathDirs.includes(entry));
  env[pathKey] = [...pathDirs, ...existingEntries].join(delimiter);
}

function pathEnvKey(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") {
    return "PATH";
  }
  const matchingKeys = Object.keys(env).filter(
    (key) => key.toLowerCase() === "path",
  );
  return matchingKeys.includes("Path")
    ? "Path"
    : (matchingKeys.at(-1) ?? "PATH");
}
