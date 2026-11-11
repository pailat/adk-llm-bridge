/**
 * MCP secrets of declared servers: whether a run can keep them from the
 * agent, their resolution when the run starts, and the run's scrubber, which
 * replaces every resolved value in the run's output with `[redacted]`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalPath, isUnder } from "../permissions/paths.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import type {
  CheckedMcpServer,
  McpSecretRef,
  McpValue,
} from "./claude-mcp-servers.js";
import {
  EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
  EXTERNAL_AGENT_MCP_SECRET_UNRESOLVED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";

/** What replaces a secret in the run's output. */
export const REDACTED = "[redacted]";

/** How long one resolver may take. */
export const MCP_SECRET_RESOLVE_TIMEOUT_MS = 10_000;

/** Shortest accepted secret, in characters. */
export const MCP_SECRET_MIN_LENGTH = 8;

/** Longest accepted secret, in UTF-8 bytes. */
export const MCP_SECRET_MAX_BYTES = 8192;

/**
 * Platforms where a live probe showed that a shell inside Claude Code's
 * no-network sandbox cannot read the environment of the host process or of a
 * stdio server (`ps -E`, `/proc/<pid>/environ`): macOS. The same probe's
 * unsandboxed shell could, so the exemption needs the sandbox. Everywhere
 * else a shell counts as able to.
 */
const SHELL_ENV_HIDDEN_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "darwin",
]);

/** What the enforceability checks need to know about the run. */
export interface McpSecretRunContext {
  /** The host platform (injectable for tests). */
  platform: NodeJS.Platform;
  /** Whether a shell tool (`Bash`, `PowerShell`) is offered. */
  shellOffered: boolean;
  /**
   * Whether the shell runs inside Claude Code's no-network sandbox (the
   * profile the macOS probe measured). False with `allowNetwork: true` or
   * `allowUnsandboxedShell: true`.
   */
  shellSandboxed: boolean;
  /** Whether a file-read tool is offered. */
  fileReadOffered: boolean;
  /** The run's permission policy. */
  policy: ExternalAgentPermissionPolicy | undefined;
  /** The run's working directory. */
  workingDirectory: string;
  /**
   * Reads `/proc/sys/kernel/yama/ptrace_scope`; `undefined` when it is
   * missing. Linux only.
   */
  readPtraceScope: () => string | undefined;
  /** The runtime child's final environment, for the debug-switch check. */
  childEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * The host facts the enforceability checks read. Tests replace its members
 * and restore them; nothing else should.
 *
 * @internal
 */
export const mcpSecretHost: {
  platform: () => NodeJS.Platform;
  readPtraceScope: () => string | undefined;
} = {
  platform: () => process.platform,
  readPtraceScope: () => readPtraceScope(),
};

/**
 * Reads the Linux Yama `ptrace_scope` setting.
 *
 * @returns The trimmed file content, or `undefined` when it cannot be read.
 */
export function readPtraceScope(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Whether reads stay away from `/proc`: the policy confines reads
 * (`allowedPaths`, `pathBounds` or `readPathBounds`), and no read root, the
 * working directory included, contains `/proc` or lies inside it.
 */
function readsExcludeProc(
  policy: ExternalAgentPermissionPolicy | undefined,
  workingDirectory: string,
): boolean {
  if (
    policy?.allowedPaths === undefined &&
    policy?.pathBounds === undefined &&
    policy?.readPathBounds === undefined
  ) {
    return false;
  }
  const roots = [
    workingDirectory,
    ...(policy.allowedPaths ?? []),
    ...(policy.readPaths ?? []),
    ...(policy.pathBounds ?? []).flat(),
    ...(policy.readPathBounds ?? []).flat(),
  ];
  return roots.every((root) => {
    const path =
      canonicalPath(root, workingDirectory) ?? resolve(workingDirectory, root);
    return !isUnder("/proc", path) && !isUnder(path, "/proc");
  });
}

/**
 * Why the agent of this run could read process environments, or `undefined`
 * when it cannot.
 *
 * @remarks True when a shell is offered (except on macOS when the shell runs
 * in Claude Code's no-network sandbox, where a live probe showed it cannot
 * read them), or on Linux when a file-read tool is offered and reads are not
 * confined away from `/proc`.
 *
 * @param run - The run's tools, platform and policy.
 * @returns The reason, for the message.
 */
export function envReadableReason(
  run: Pick<
    McpSecretRunContext,
    | "platform"
    | "shellOffered"
    | "shellSandboxed"
    | "fileReadOffered"
    | "policy"
    | "workingDirectory"
  >,
): string | undefined {
  if (run.shellOffered && !SHELL_ENV_HIDDEN_PLATFORMS.has(run.platform)) {
    return "a shell tool is offered, and it can read process environments on this platform";
  }
  if (run.shellOffered && !run.shellSandboxed) {
    return "a shell tool runs without Claude Code's no-network sandbox (allowNetwork: true or allowUnsandboxedShell: true), so it can read process environments";
  }
  if (
    run.platform === "linux" &&
    run.fileReadOffered &&
    !readsExcludeProc(run.policy, run.workingDirectory)
  ) {
    return "a file-read tool is offered and reads are not confined away from /proc (set allowedPaths and readPaths that exclude /proc)";
  }
  return undefined;
}

function isSecretRef(value: McpValue): value is McpSecretRef {
  return !("public" in value);
}

function secretValues(
  server: CheckedMcpServer,
): { field: "header" | "env"; key: string; value: McpSecretRef }[] {
  const out: { field: "header" | "env"; key: string; value: McpSecretRef }[] =
    [];
  const add = (
    field: "header" | "env",
    values: Readonly<Record<string, McpValue>> | undefined,
  ) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (isSecretRef(value)) out.push({ field, key, value });
    }
  };
  add("header", server.type === "stdio" ? undefined : server.headers);
  add("env", server.type === "stdio" ? server.env : undefined);
  return out;
}

/**
 * Whether any declared server carries a secret reference.
 *
 * @param servers - The checked servers.
 * @returns True when at least one value is `{ resolve }` or `{ env }`.
 */
export function hasMcpSecrets(servers: readonly CheckedMcpServer[]): boolean {
  return servers.some((server) => secretValues(server).length > 0);
}

/**
 * Names of debug switches that make the runtime log its traffic or config.
 *
 * @param name - An environment variable name.
 * @returns True for `DEBUG`, `ANTHROPIC_LOG`, `CLAUDE_DEBUG` and
 * `CLAUDE_CODE_DEBUG*`, ignoring case.
 */
export function isDebugSwitch(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper === "DEBUG" ||
    upper === "ANTHROPIC_LOG" ||
    upper === "CLAUDE_DEBUG" ||
    upper.startsWith("CLAUDE_CODE_DEBUG")
  );
}

function unenforceable(message: string): never {
  throw new ExternalAgentPolicyError(
    EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
    `ClaudeAgentSdkDriver: ${message}`,
  );
}

/**
 * Refuses a run that could not keep a declared server's secret from the
 * agent. Applies to declared servers in both modes.
 *
 * @remarks In order:
 * 1. the agent can read process environments ({@link envReadableReason}) and
 *    an `{ env }` reference, or any stdio env secret, is used;
 * 2. Linux, a shell is offered, and `ptrace_scope` is missing or `0`: the
 *    shell could read the memory of the runtime or a stdio server;
 * 3. Windows and a shell is offered: same-user processes can read process
 *    memory;
 * 4. a debug switch is in the runtime's environment;
 * 5. an `{ env }` reference names a variable that the runtime's own
 *    environment also holds (a credential variable through the provider's
 *    `envAllowlist`): the runtime's tools inherit it.
 *
 * @param servers - The checked declared servers.
 * @param run - The run's tools, platform, policy and child environment.
 * @throws ExternalAgentPolicyError `EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`.
 */
export function checkMcpSecretsEnforceable(
  servers: readonly CheckedMcpServer[],
  run: McpSecretRunContext,
): void {
  if (!hasMcpSecrets(servers)) {
    return;
  }
  const readable = envReadableReason(run);
  if (readable !== undefined) {
    for (const server of servers) {
      for (const { field, key, value } of secretValues(server)) {
        if ("env" in value) {
          unenforceable(
            `MCP server ${server.name}: ${field} ${JSON.stringify(key)} uses { env }, but ${readable}, so the agent could read the variable from the host process. Use { resolve }, or drop the shell or file-read tools.`,
          );
        }
        if (field === "env") {
          unenforceable(
            `MCP server ${server.name}: env ${JSON.stringify(key)} is a secret, but ${readable}, so the agent could read it from the server process. Pass the secret in a header of an http server, or drop the shell or file-read tools.`,
          );
        }
      }
    }
  }
  if (run.platform === "linux" && run.shellOffered) {
    const scope = run.readPtraceScope();
    if (scope === undefined || scope === "0") {
      unenforceable(
        "Linux ptrace_scope is 0 (or unknown), so the agent's shell could read the memory of the runtime or a stdio server, and with it any MCP secret. Set kernel.yama.ptrace_scope to 1 or more, or drop the shell tools.",
      );
    }
  }
  if (run.platform === "win32" && run.shellOffered) {
    unenforceable(
      "Windows: same-user processes can read process memory, so the agent's shell could read any MCP secret. Drop the shell tools, or use a server that needs no secret.",
    );
  }
  for (const server of servers) {
    for (const { field, key, value } of secretValues(server)) {
      if ("env" in value && run.childEnv[value.env]) {
        unenforceable(
          `MCP server ${server.name}: ${field} ${JSON.stringify(key)} uses { env: ${JSON.stringify(value.env)} }, but that variable is also in the runtime's own environment, which its tools inherit. Use a variable the runtime does not get, or { resolve }.`,
        );
      }
    }
  }
  for (const [name, value] of Object.entries(run.childEnv)) {
    if (value !== undefined && isDebugSwitch(name)) {
      unenforceable(
        `the runtime's environment sets the debug switch ${name}, which could log MCP secrets. Remove the debug variable.`,
      );
    }
  }
}

/** A declared server with its secret values read. */
export interface ResolvedMcpServer {
  /** The server name. */
  name: string;
  /** Header values, http and sse only. */
  headers?: Record<string, string>;
  /** Env values, stdio only. */
  env?: Record<string, string>;
}

function unresolved(
  server: string,
  field: string,
  key: string,
  why: string,
): never {
  throw new ExternalAgentPolicyError(
    EXTERNAL_AGENT_MCP_SECRET_UNRESOLVED,
    `ClaudeAgentSdkDriver: MCP server ${server}: the secret for ${field} ${JSON.stringify(key)} ${why}.`,
  );
}

async function runResolver(
  ref: Extract<McpSecretRef, { resolve: unknown }>,
  context: { server: string; field: "header" | "env"; key: string },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    unresolved(
      context.server,
      context.field,
      context.key,
      "was not read: the run was aborted",
    );
  }
  signal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new Promise<"timeout" | "aborted">((resolveStop) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      resolveStop("timeout");
    }, timeoutMs);
    controller.signal.addEventListener(
      "abort",
      () => resolveStop(signal.aborted ? "aborted" : "timeout"),
      { once: true },
    );
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => ref.resolve({ ...context, signal: controller.signal }))
        .then(
          (value) => ({ value }),
          () => ({ failed: true as const }),
        ),
      stop,
    ]);
    if (outcome === "timeout") {
      unresolved(
        context.server,
        context.field,
        context.key,
        `was not read: the resolver took longer than ${timeoutMs} ms`,
      );
    }
    if (outcome === "aborted") {
      unresolved(
        context.server,
        context.field,
        context.key,
        "was not read: the run was aborted",
      );
    }
    if ("failed" in outcome) {
      // The resolver's error text may hold the secret: never quote it.
      unresolved(
        context.server,
        context.field,
        context.key,
        "was not read: the resolver threw",
      );
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads every secret of the declared servers, after every other check. Each
 * value read joins `scrubber` before it is returned.
 *
 * @param servers - The checked declared servers.
 * @param options - The driver's environment (for `{ env }`), the runtime's
 * own environment (a secret found in one of its values is refused), the
 * run's abort signal, the scrubber, and the per-resolver timeout.
 * @returns Each server's header or env values, `{ public }` ones included.
 * @throws ExternalAgentPolicyError `EXTERNAL_AGENT_MCP_SECRET_UNRESOLVED`,
 * naming the server, field and key only; `EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`
 * when the value is already in the runtime's environment.
 */
export async function resolveMcpSecrets(
  servers: readonly CheckedMcpServer[],
  options: {
    env: Readonly<Record<string, string | undefined>>;
    childEnv?: Readonly<Record<string, string | undefined>>;
    signal: AbortSignal;
    scrubber: SecretScrubber;
    timeoutMs?: number;
  },
): Promise<ResolvedMcpServer[]> {
  const timeoutMs = options.timeoutMs ?? MCP_SECRET_RESOLVE_TIMEOUT_MS;
  const out: ResolvedMcpServer[] = [];
  for (const server of servers) {
    const field: "header" | "env" = server.type === "stdio" ? "env" : "header";
    const values = server.type === "stdio" ? server.env : server.headers;
    if (values === undefined) {
      out.push({ name: server.name });
      continue;
    }
    const read: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if ("public" in value) {
        read[key] = value.public;
        continue;
      }
      let secret: unknown;
      if ("env" in value) {
        secret = options.env[value.env];
        if (secret === undefined || secret === "") {
          unresolved(
            server.name,
            field,
            key,
            `was not read: the variable ${value.env} is missing or empty`,
          );
        }
      } else {
        secret = await runResolver(
          value,
          { server: server.name, field, key },
          options.signal,
          timeoutMs,
        );
      }
      if (typeof secret !== "string") {
        unresolved(
          server.name,
          field,
          key,
          "was not read: the resolver did not return a string",
        );
      }
      if (secret.length < MCP_SECRET_MIN_LENGTH) {
        unresolved(
          server.name,
          field,
          key,
          `is shorter than ${MCP_SECRET_MIN_LENGTH} characters`,
        );
      }
      if (Buffer.byteLength(secret, "utf8") > MCP_SECRET_MAX_BYTES) {
        unresolved(
          server.name,
          field,
          key,
          `is longer than ${MCP_SECRET_MAX_BYTES} bytes`,
        );
      }
      if (/[\r\n\0]/u.test(secret)) {
        unresolved(server.name, field, key, "has a CR, LF or NUL character");
      }
      options.scrubber.add(secret);
      if (
        Object.values(options.childEnv ?? {}).some(
          (held) => held?.includes(secret as string) === true,
        )
      ) {
        unenforceable(
          `MCP server ${server.name}: the secret for ${field} ${JSON.stringify(key)} is also in the runtime's own environment, which its tools inherit. Give the server a value the runtime does not get.`,
        );
      }
      const full = `${value.prefix ?? ""}${secret}`;
      options.scrubber.add(full);
      read[key] = full;
    }
    out.push(
      server.type === "stdio"
        ? { name: server.name, env: read }
        : { name: server.name, headers: read },
    );
  }
  return out;
}

function base64Forms(value: string): string[] {
  const standard = Buffer.from(value, "utf8").toString("base64");
  const unpadded = standard.replace(/=+$/u, "");
  const urlSafe = unpadded.replace(/\+/gu, "-").replace(/\//gu, "_");
  const urlSafePadded = urlSafe + standard.slice(unpadded.length);
  return [standard, unpadded, urlSafe, urlSafePadded];
}

/**
 * Replaces the run's secrets with `[redacted]` in any string, in the forms a
 * secret can take on the way out: raw, `encodeURIComponent`, base64
 * (standard and URL-safe, padded and unpadded) and JSON-escaped (once and
 * twice). Cleared when the run ends.
 *
 * @remarks A secret inside a larger base64 or otherwise encoded blob, not
 * aligned on its own, is not found; a server must not echo credentials.
 */
export class SecretScrubber {
  #forms: string[] = [];

  /**
   * Adds a secret, in all its forms.
   *
   * @param secret - The secret value.
   */
  add(secret: string): void {
    if (secret.length === 0) return;
    const once = JSON.stringify(secret).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    const forms = new Set([
      ...this.#forms,
      secret,
      encodeURIComponent(secret),
      ...base64Forms(secret),
      once,
      twice,
    ]);
    // Longest first, so a longer form is replaced before a form inside it.
    this.#forms = [...forms]
      .filter((form) => form.length > 0)
      .sort((a, b) => b.length - a.length);
  }

  /** Whether any secret was added. */
  get active(): boolean {
    return this.#forms.length > 0;
  }

  /**
   * Scrubs one string.
   *
   * @param text - Any text.
   * @returns The text with every form of every secret replaced.
   */
  scrub(text: string): string {
    let out = text;
    for (const form of this.#forms) {
      if (out.includes(form)) {
        out = out.split(form).join(REDACTED);
      }
    }
    return out;
  }

  /**
   * Scrubs every string in a value: arrays and plain objects are copied
   * with their strings (keys included) scrubbed; cycles are kept. An
   * `Error` whose message changed becomes a new `Error` with only `name`
   * and the scrubbed `message` (its `code`, `cause` and other fields are
   * dropped). Class instances and other values are returned as they are,
   * unscrubbed, so callers pass plain data (events are plain objects).
   *
   * @param value - Any value.
   * @returns The scrubbed value, and whether anything changed.
   */
  scrubDeep<T>(value: T): { value: T; changed: boolean } {
    if (!this.active) return { value, changed: false };
    let changed = false;
    const seen = new Map<object, unknown>();
    const walk = (current: unknown): unknown => {
      if (typeof current === "string") {
        const scrubbed = this.scrub(current);
        if (scrubbed !== current) changed = true;
        return scrubbed;
      }
      if (typeof current !== "object" || current === null) return current;
      const known = seen.get(current);
      if (known !== undefined) return known;
      if (Array.isArray(current)) {
        const copy: unknown[] = [];
        seen.set(current, copy);
        for (const item of current) copy.push(walk(item));
        return copy;
      }
      const proto = Object.getPrototypeOf(current);
      if (current instanceof Error) {
        const message = this.scrub(current.message);
        if (message !== current.message) {
          changed = true;
          const copy = new Error(message);
          copy.name = current.name;
          return copy;
        }
        return current;
      }
      if (proto !== Object.prototype && proto !== null) return current;
      const copy: Record<string, unknown> =
        proto === null ? Object.create(null) : {};
      seen.set(current, copy);
      for (const [key, item] of Object.entries(current)) {
        const scrubbedKey = this.scrub(key);
        if (scrubbedKey !== key) changed = true;
        copy[scrubbedKey] = walk(item);
      }
      return copy;
    };
    const out = walk(value) as T;
    return changed ? { value: out, changed } : { value, changed: false };
  }

  /** Forgets every secret. */
  clear(): void {
    this.#forms = [];
  }
}
