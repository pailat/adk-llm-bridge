/**
 * The `toolEnv` option of the Claude drivers: variables the host passes to
 * the tools of a Claude run (`gh`, a git credential helper, a proxy or CA
 * bundle), apart from the model credential.
 */

import { InputValidationError } from "@google/adk";
import { isDebugSwitch } from "./mcp-secrets.js";
import { isClaudeModelEnv } from "./model.js";
import {
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";

/** Where `toolEnv` reads its values: a record, or a function read per run. */
export type ClaudeToolEnvSource =
  | Readonly<Record<string, string | undefined>>
  | (() => Readonly<Record<string, string | undefined>>);

/**
 * Variables a Claude driver passes from the host to the Claude Code child
 * process, for the tools the agent runs. Off when unset: the child
 * environment is then exactly what it was without the option.
 */
export interface ClaudeToolEnv {
  /**
   * Variable names to copy. Each must match the run-spec env grammar
   * (`[A-Za-z_][A-Za-z0-9_]{0,127}`) and appear once. Model
   * names, debug switches and names the runtime itself reads (`PATH`,
   * `HOME`, `TMPDIR`, `ANTHROPIC_*`, `CLAUDE_*`, `NODE_*` except
   * `NODE_EXTRA_CA_CERTS`, `UV_*`, loader variables such as `LD_PRELOAD`)
   * are refused when the driver is built. Names are compared without
   * regard to case, as Windows does: a name may appear once in any case.
   * Only a set, non-empty string value is copied.
   */
  names?: readonly string[];
  /**
   * Where the values come from. A function is called once per run (and on
   * each direct `buildEnv` call outside a run), so a host can hand out a
   * fresh token per run. It must return a plain object synchronously: a
   * Promise, `null` or any other value fails the run with
   * {@link CLAUDE_TOOL_ENV_SOURCE_FAILED}. The run copies the values of the
   * names it passes once, so every check of the run sees the values
   * delivered, even when the source object changes later.
   *
   * @defaultValue the driver's `env` option (`process.env` when unset)
   */
  source?: ClaudeToolEnvSource;
  /**
   * Also copy the proxy and CA variables in
   * {@link CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH} from the driver's `env`, as
   * the Codex SDK driver copies them from its ambient environment. A set,
   * non-empty value in `source` wins, so a run can use its own proxy.
   *
   * @defaultValue false
   */
  proxyPassthrough?: boolean;
}

/**
 * The proxy and CA variables `proxyPassthrough` copies: the Codex SDK
 * driver's list (without `CODEX_HOME`) plus `NODE_EXTRA_CA_CERTS`, the CA
 * variable Node-based tools read.
 */
export const CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH: readonly string[] =
  Object.freeze([
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]);

/**
 * Code of the non-recoverable `error` event a Claude driver run reports when
 * its `toolEnv.source` function throws or returns something other than a
 * plain object. The run ends before Claude Code is started.
 */
export const CLAUDE_TOOL_ENV_SOURCE_FAILED = "CLAUDE_TOOL_ENV_SOURCE_FAILED";

/** A `toolEnv` source function that threw or returned no plain object. */
export class ClaudeToolEnvSourceError extends Error {
  readonly code = CLAUDE_TOOL_ENV_SOURCE_FAILED;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeToolEnvSourceError";
  }
}

/**
 * The run's copy of the `toolEnv` values: every name the option passes,
 * mapped to its set, non-empty value. Frozen.
 */
export type ClaudeToolEnvSnapshot = Readonly<Record<string, string>>;

const EMPTY_SNAPSHOT: ClaudeToolEnvSnapshot = Object.freeze({});

/** The run-spec env grammar (`src/workflows/spec/schema.ts`). */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** Names the drivers set or the runtime reads itself (upper case). */
const RUNTIME_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "ENABLE_MCP_LARGE_OUTPUT_FILES",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
]);

/**
 * Prefixes of names the runtime reads itself (upper case). `NODE_*` covers
 * `NODE_OPTIONS`, `NODE_PATH` and `NODE_TLS_REJECT_UNAUTHORIZED` (which
 * would turn off TLS checks on the model traffic); `UV_*` the libuv
 * settings.
 */
const RUNTIME_PREFIXES: readonly string[] = Object.freeze([
  "ANTHROPIC_",
  "CLAUDE_",
  "DYLD_",
  "NODE_",
  "UV_",
]);

/** Runtime-prefixed names a tool may still need (upper case). */
const RUNTIME_EXCEPTIONS: ReadonlySet<string> = new Set([
  "NODE_EXTRA_CA_CERTS",
]);

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "names",
  "source",
  "proxyPassthrough",
]);

/** A checked `toolEnv`: what the driver keeps. */
export interface CheckedClaudeToolEnv {
  /** The listed names, read from the source. */
  readonly names: readonly string[];
  /**
   * Every `proxyPassthrough` name, listed in `names` or not (empty when it
   * is off), read from the driver env unless the source sets them.
   */
  readonly proxyNames: readonly string[];
  /** The source, or `undefined` for the driver env. */
  readonly source?: ClaudeToolEnvSource;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks a driver's `toolEnv` option when the driver is built.
 *
 * @param driver - Driver name for the messages.
 * @param option - The configured `toolEnv`.
 * @returns The checked option, or `undefined` when it is unset.
 * @throws InputValidationError when the option is malformed, a name breaks
 * the run-spec env grammar or a name repeats.
 * @throws ExternalAgentPolicyError `EXTERNAL_AGENT_MODEL_OVERRIDE` for a
 * model name, `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for a debug switch or a
 * name the runtime reads itself.
 */
export function checkClaudeToolEnv(
  driver: string,
  option: unknown,
): CheckedClaudeToolEnv | undefined {
  if (option === undefined) return undefined;
  const invalid = (detail: string) =>
    new InputValidationError(`${driver}: toolEnv ${detail}.`);
  if (!isPlainObject(option)) {
    throw invalid("must be an object with names, source and proxyPassthrough");
  }
  const unknown = Object.keys(option).find((key) => !KNOWN_KEYS.has(key));
  if (unknown !== undefined) {
    throw invalid(`has an unknown key ${JSON.stringify(unknown)}`);
  }
  const { names = [], source, proxyPassthrough = false } = option;
  if (!Array.isArray(names)) {
    throw invalid("names must be an array of variable names");
  }
  if (typeof proxyPassthrough !== "boolean") {
    throw invalid("proxyPassthrough must be a boolean (true or false)");
  }
  if (
    source !== undefined &&
    typeof source !== "function" &&
    !isPlainObject(source)
  ) {
    throw invalid("source must be an object of variables or a function");
  }
  const seen = new Set<string>();
  const seenUpper = new Set<string>();
  for (const name of names as unknown[]) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
      throw invalid(
        `name ${JSON.stringify(name)} does not match the run-spec env grammar [A-Za-z_][A-Za-z0-9_]{0,127}`,
      );
    }
    const upper = name.toUpperCase();
    if (seenUpper.has(upper)) {
      throw invalid(
        `lists ${name} more than once (names are compared without regard to case)`,
      );
    }
    seenUpper.add(upper);
    seen.add(name);
    if (isClaudeModelEnv(name)) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MODEL_OVERRIDE,
        `${driver}: toolEnv lists ${name}, which would change the model the runtime runs, so the model the bridge reports would be wrong. Remove ${name} from toolEnv and set the driver's model option instead.`,
      );
    }
    if (isDebugSwitch(name)) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        `${driver}: toolEnv lists the debug switch ${name}, which could make the runtime log its traffic, credentials and MCP secrets. Remove it from toolEnv.`,
      );
    }
    if (
      RUNTIME_NAMES.has(upper) ||
      (!RUNTIME_EXCEPTIONS.has(upper) &&
        RUNTIME_PREFIXES.some((prefix) => upper.startsWith(prefix)))
    ) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        `${driver}: toolEnv lists ${name}, a variable the driver sets or the Claude Code runtime reads itself. toolEnv is for the agent's tools; pass model credentials through the provider envAllowlist and runtime settings through the driver options.`,
      );
    }
  }
  const proxyNames = proxyPassthrough ? CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH : [];
  return Object.freeze({
    names: Object.freeze([...seen]),
    proxyNames: Object.freeze(proxyNames),
    ...(source !== undefined ? { source: source as ClaudeToolEnvSource } : {}),
  });
}

/**
 * Every variable name a `toolEnv` can pass: the listed names and the
 * `proxyPassthrough` ones. An MCP `{ env }` secret may use none of them.
 *
 * @param toolEnv - The checked option, or `undefined` when it is off.
 * @returns The names (empty when the option is off).
 */
export function claudeToolEnvNames(
  toolEnv: CheckedClaudeToolEnv | undefined,
): readonly string[] {
  return toolEnv === undefined
    ? []
    : [...new Set([...toolEnv.names, ...toolEnv.proxyNames])];
}

/** Says what a source function returned instead of a plain object. */
function describeSourceResult(result: unknown): string {
  if (result === null) return "null";
  if (Array.isArray(result)) return "an array";
  if (typeof (result as { then?: unknown } | undefined)?.then === "function") {
    return "a Promise (the source must return its values synchronously)";
  }
  return typeof result === "object"
    ? "an object that is not plain"
    : typeof result;
}

/**
 * Reads the `toolEnv` source once and copies the values the option passes.
 * A run takes one snapshot and builds every child environment of the run
 * from it, so a function that mints a token is called once per run, and a
 * source object (or driver env) that changes later is not seen.
 *
 * @remarks
 * Security invariant: only the checked names are read, and only set,
 * non-empty string values are copied; neither the source nor the driver env
 * is copied whole. A listed name is read from the source; a
 * `proxyPassthrough` name from the source when it sets one, else from the
 * driver env.
 *
 * @param toolEnv - The checked option, or `undefined` when it is off.
 * @param driverEnv - The driver's `env`, the default source.
 * @returns The frozen snapshot: empty, without reading the source, when the
 * option is off or passes no name.
 * @throws ClaudeToolEnvSourceError when a source function throws or returns
 * something other than a plain object.
 */
export function readClaudeToolEnvSource(
  toolEnv: CheckedClaudeToolEnv | undefined,
  driverEnv: Readonly<Record<string, string | undefined>>,
): ClaudeToolEnvSnapshot {
  if (toolEnv === undefined || claudeToolEnvNames(toolEnv).length === 0) {
    return EMPTY_SNAPSHOT;
  }
  let source: Readonly<Record<string, unknown>>;
  if (typeof toolEnv.source === "function") {
    let result: unknown;
    try {
      result = toolEnv.source();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ClaudeToolEnvSourceError(`toolEnv.source threw: ${detail}`, {
        cause: error,
      });
    }
    if (!isPlainObject(result)) {
      throw new ClaudeToolEnvSourceError(
        `toolEnv.source returned ${describeSourceResult(result)}, not an object of variables`,
      );
    }
    source = result;
  } else {
    source = toolEnv.source ?? driverEnv;
  }
  const out: Record<string, string> = {};
  const copy = (name: string, value: unknown): boolean => {
    if (typeof value !== "string" || value.length === 0) return false;
    out[name] = value;
    return true;
  };
  for (const name of toolEnv.names) copy(name, source[name]);
  // A listed proxy name was read from the source above; this loop adds the
  // driver env value when the source sets none.
  for (const name of toolEnv.proxyNames) {
    if (Object.hasOwn(out, name)) continue;
    if (!copy(name, source[name])) copy(name, driverEnv[name]);
  }
  return Object.freeze(out);
}

/**
 * The `toolEnv` variables of one child environment, from the run's
 * snapshot. Names in `skip` (the run's credential variables) are left out,
 * compared without regard to case, so a credential keeps its value and the
 * child never holds two spellings of one variable.
 *
 * @param snapshot - The run's snapshot from {@link readClaudeToolEnvSource}.
 * @param skip - Variables the child gets from elsewhere, which win.
 * @returns The variables to add (empty when the option is off).
 */
export function claudeToolEnvValues(
  snapshot: ClaudeToolEnvSnapshot,
  skip: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const skipped = new Set(Object.keys(skip).map((name) => name.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(snapshot)) {
    if (!skipped.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}
