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

/** Where `toolEnv` reads its values: a record, or a function read per build. */
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
   * `HOME`, `TMPDIR`, `ANTHROPIC_*`, `CLAUDE_*`, loader variables such as
   * `NODE_OPTIONS`) are refused when the driver is built. Only a set,
   * non-empty string value is copied.
   */
  names?: readonly string[];
  /**
   * Where the values come from. A function is called once per run (and on
   * each direct `buildEnv` call outside a run), so a host can hand out a
   * fresh token per run; every check of the run sees the value delivered.
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
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
]);

/** Prefixes of names the runtime reads itself (upper case). */
const RUNTIME_PREFIXES: readonly string[] = Object.freeze([
  "ANTHROPIC_",
  "CLAUDE_",
  "DYLD_",
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
   * The `proxyPassthrough` names not listed in `names` (empty when it is
   * off), read from the driver env unless the source sets them.
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
  for (const name of names as unknown[]) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
      throw invalid(
        `name ${JSON.stringify(name)} does not match the run-spec env grammar [A-Za-z_][A-Za-z0-9_]{0,127}`,
      );
    }
    if (seen.has(name)) throw invalid(`lists ${name} more than once`);
    seen.add(name);
    const upper = name.toUpperCase();
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
      RUNTIME_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        `${driver}: toolEnv lists ${name}, a variable the driver sets or the Claude Code runtime reads itself. toolEnv is for the agent's tools; pass model credentials through the provider envAllowlist and runtime settings through the driver options.`,
      );
    }
  }
  const proxyNames = proxyPassthrough
    ? CLAUDE_TOOL_ENV_PROXY_PASSTHROUGH.filter((key) => !seen.has(key))
    : [];
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
  return toolEnv === undefined ? [] : [...toolEnv.names, ...toolEnv.proxyNames];
}

/**
 * Reads the `toolEnv` source once: calls a source function, or returns the
 * source record (the driver env when unset). A run takes one snapshot and
 * builds every child environment of the run from it, so a function that
 * mints a token is called once per run.
 *
 * @param toolEnv - The checked option, or `undefined` when it is off.
 * @param driverEnv - The driver's `env`, the default source.
 * @returns The source values, or `undefined` when the option is off or
 * passes no name (the source is then not read).
 */
export function readClaudeToolEnvSource(
  toolEnv: CheckedClaudeToolEnv | undefined,
  driverEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> | undefined {
  if (toolEnv === undefined || claudeToolEnvNames(toolEnv).length === 0) {
    return undefined;
  }
  return typeof toolEnv.source === "function"
    ? toolEnv.source()
    : (toolEnv.source ?? driverEnv);
}

/**
 * The `toolEnv` variables of one child environment.
 *
 * @remarks
 * Security invariant: only the checked names are read, and only set,
 * non-empty string values are copied; neither the source nor the driver env
 * is copied whole. A listed name is read from the source; a
 * `proxyPassthrough` name from the source when it sets one, else from the
 * driver env. Names in `skip` (the run's credential variables) are left
 * out, so a credential keeps its value.
 *
 * @param toolEnv - The checked option, or `undefined` when it is off.
 * @param driverEnv - The driver's `env`, the default source.
 * @param skip - Variables the child gets from elsewhere, which win.
 * @param snapshot - The run's source snapshot from
 * {@link readClaudeToolEnvSource}; the source is read here when unset.
 * @returns The variables to add (empty when the option is off).
 */
export function claudeToolEnvValues(
  toolEnv: CheckedClaudeToolEnv | undefined,
  driverEnv: Readonly<Record<string, string | undefined>>,
  skip: Readonly<Record<string, string>>,
  snapshot?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (toolEnv === undefined || claudeToolEnvNames(toolEnv).length === 0) {
    return {};
  }
  const source = snapshot ?? readClaudeToolEnvSource(toolEnv, driverEnv);
  const out: Record<string, string> = {};
  const copy = (name: string, value: unknown): boolean => {
    if (typeof value !== "string" || value.length === 0) return false;
    out[name] = value;
    return true;
  };
  for (const name of toolEnv.names) {
    if (!Object.hasOwn(skip, name)) copy(name, source?.[name]);
  }
  for (const name of toolEnv.proxyNames) {
    if (Object.hasOwn(skip, name)) continue;
    if (!copy(name, source?.[name])) copy(name, driverEnv[name]);
  }
  return out;
}
