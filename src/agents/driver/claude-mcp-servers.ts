/**
 * MCP servers the host declares for a Claude Agent SDK agent: the config
 * types, the checks made when the driver is built (shape, names, URL grammar,
 * secret literals), the checks made when a run starts (network, stdio), and
 * {@link selectMcpServers} for run-spec provider ids.
 *
 * Every check fails closed: anything that does not match the accepted forms
 * exactly is refused with a typed {@link ExternalAgentPolicyError}.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, win32 } from "node:path";
import { networkAllowed } from "../permissions/network.js";
import { isUnderAny } from "../permissions/paths.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { BRIDGE_MCP_SERVER } from "../tools/adk-tool-bridge.js";
import {
  EXTERNAL_AGENT_MCP_PROVIDER_UNKNOWN,
  EXTERNAL_AGENT_MCP_SECRET_LITERAL,
  EXTERNAL_AGENT_MCP_SERVER_INVALID,
  EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED,
  EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
  ExternalAgentPolicyError,
} from "./policy-errors.js";

/**
 * Reads one MCP secret when a run starts. Called once per value per run,
 * after every other check passed; the value is never logged or stored.
 *
 * @remarks Its safety depends on where it reads from, which the bridge cannot
 * see: `() => process.env.X` is exactly as exposed as `{ env: "X" }`, and a
 * resolver that reads a file or runs a keychain tool is only as safe as the
 * agent's inability to do the same read. The robust source is a short-lived,
 * run-scoped token minted by a host proxy that keeps the long-lived
 * credential.
 *
 * @experimental
 */
export type McpSecretResolver = (context: {
  /** The server name. */
  server: string;
  /** Where the value goes. */
  field: "header" | "env";
  /** The header or env variable name. */
  key: string;
  /** Aborts with the run, or when resolution times out (10 s). */
  signal: AbortSignal;
}) => string | Promise<string>;

/**
 * A secret by reference. `{ resolve }` is the recommended form. `{ env }`
 * reads the driver's `env` (default `process.env`) when the run starts, and
 * is refused where the agent can read process environments. `prefix` (for
 * example `"Bearer "`) is joined to the value in memory only.
 *
 * @experimental
 */
export type McpSecretRef =
  | { resolve: McpSecretResolver; prefix?: string }
  | { env: string; prefix?: string };

/**
 * A value that is not secret, marked explicitly. Refused under a name that
 * looks secret.
 *
 * @experimental
 */
export interface McpPublicValue {
  /** The value, passed on as is. */
  public: string;
}

/**
 * A header or env value of a declared MCP server. A bare string is refused:
 * every value says whether it is secret.
 *
 * @experimental
 */
export type McpValue = McpSecretRef | McpPublicValue;

/**
 * Options common to every declared MCP server.
 *
 * @experimental
 */
export interface ClaudeMcpServerCommon {
  /**
   * Tool names without the `mcp__<server>__` prefix. Absent: every tool of
   * the server. A call to any other tool is denied.
   */
  tools?: readonly string[];
  /**
   * The host's attestation that the listed `tools` only read. Under a
   * `read-only` policy, only listed tools of servers with `readOnly: true`
   * run. Requires a non-empty `tools`. Default `false`.
   */
  readOnly?: boolean;
  /** Per-call timeout, 1000 to 600000 ms. Default: the runtime's. */
  timeoutMs?: number;
}

/**
 * An MCP server over Streamable HTTP or SSE.
 *
 * @experimental
 */
export interface ClaudeMcpHttpServer extends ClaudeMcpServerCommon {
  /** Transport. */
  type: "http" | "sse";
  /**
   * `http://127.D.D.D[:port][/path]` or `http://[::1][:port][/path]` on
   * loopback, or an `https` URL anywhere else (only when the policy sets
   * `allowNetwork: true`). No user, password, query, fragment or `%`.
   * Passed on in its canonical form.
   */
  url: string;
  /**
   * Request headers. Put a secret in `Authorization`: an HTTP client drops
   * that header on a redirect to another origin, but keeps other headers.
   */
  headers?: Readonly<Record<string, McpValue>>;
}

/**
 * An MCP server the runtime starts as a child process, outside the agent's
 * sandbox, in the agent's working directory.
 *
 * @experimental
 */
export interface ClaudeMcpStdioServer extends ClaudeMcpServerCommon {
  /** Transport. */
  type: "stdio";
  /**
   * Absolute path to a host executable outside every directory the agent can
   * write. Package launchers (`npx`, `uvx`, `bun`, ...) are refused. Passed
   * on as its real path. A server that needs a working directory is a host
   * wrapper script that does `cd /abs/dir && exec ...`.
   */
  command: string;
  /**
   * Arguments: each is a flag (`-v`, `--name` or `--name=value`) or an
   * absolute path. Flags that load code or open a debugger are refused.
   * Public: visible in the process list.
   */
  args?: readonly string[];
  /**
   * Environment of the server. Variables that load code (`NODE_OPTIONS`,
   * `PYTHONPATH`, `PATH`, `LD_*`, ...) are refused, and secret values are
   * refused where the agent can read process environments.
   */
  env?: Readonly<Record<string, McpValue>>;
}

/**
 * An MCP server the host declares for the agent.
 *
 * @experimental
 */
export type ClaudeMcpServer = ClaudeMcpHttpServer | ClaudeMcpStdioServer;

/**
 * A declared server as the driver keeps it after the construction checks.
 *
 * @internal
 */
export type CheckedMcpServer =
  | (Omit<ClaudeMcpHttpServer, "tools" | "readOnly"> & {
      readonly name: string;
      readonly tools?: readonly string[];
      readonly readOnly: boolean;
      /** Whether the URL is on loopback. */
      readonly loopback: boolean;
    })
  | (Omit<ClaudeMcpStdioServer, "tools" | "readOnly"> & {
      readonly name: string;
      readonly tools?: readonly string[];
      readonly readOnly: boolean;
    });

/** Most declared MCP servers on one driver. */
export const MAX_CLAUDE_MCP_SERVERS = 16;

/**
 * Server name grammar, the MCP provider id grammar of run specs: ASCII
 * letters and digits in runs joined by one `-` or `_`, at most 64 characters.
 * No `__`, so the prefix of `mcp__<server>__<tool>` names one server.
 */
export const CLAUDE_MCP_SERVER_NAME_PATTERN =
  /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/** Header names that always carry a credential. */
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
]);
const SENSITIVE_NAME_PATTERN =
  /token|secret|key|auth|cookie|session|passw|credential/iu;

/**
 * Whether a header or env name looks like it carries a secret, so a
 * `{ public }` value under it is refused.
 *
 * @param name - Header or env variable name.
 * @returns True for a sensitive name.
 */
export function isSensitiveMcpValueName(name: string): boolean {
  return (
    SENSITIVE_NAMES.has(name.toLowerCase()) || SENSITIVE_NAME_PATTERN.test(name)
  );
}

const HTTP_KEYS: ReadonlySet<string> = new Set([
  "type",
  "url",
  "headers",
  "tools",
  "readOnly",
  "timeoutMs",
]);
const STDIO_KEYS: ReadonlySet<string> = new Set([
  "type",
  "command",
  "args",
  "env",
  "tools",
  "readOnly",
  "timeoutMs",
]);

function invalid(message: string): never {
  throw new ExternalAgentPolicyError(
    EXTERNAL_AGENT_MCP_SERVER_INVALID,
    `ClaudeAgentSdkDriver: ${message}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return (
    (proto === Object.prototype || proto === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function quote(value: string): string {
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}...` : value);
}

/**
 * Checks the `mcpServers` option when the driver is built.
 *
 * @remarks Refuses (`EXTERNAL_AGENT_MCP_SERVER_INVALID`) a name outside
 * {@link CLAUDE_MCP_SERVER_NAME_PATTERN}, `adk_bridge`, a duplicate after
 * case folding, more than {@link MAX_CLAUDE_MCP_SERVERS} servers, an unknown
 * `type` or key, a URL outside the accepted grammar, a bad `tools` entry,
 * `readOnly` without `tools`, a `timeoutMs` out of range, a relative stdio
 * `command`, or a bad header or env name; and
 * (`EXTERNAL_AGENT_MCP_SECRET_LITERAL`) a bare string value or a `{ public }`
 * value under a sensitive name. The network and stdio rules that need the run
 * are checked when it starts ({@link checkMcpServersForRun}).
 *
 * @param value - The option as given.
 * @returns The checked servers, frozen, in the given order.
 * @throws ExternalAgentPolicyError
 */
export function checkClaudeMcpServers(
  value: unknown,
): readonly CheckedMcpServer[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!isPlainObject(value)) {
    invalid("mcpServers must be a plain object of server name to server.");
  }
  const names = Object.keys(value);
  if (names.length > MAX_CLAUDE_MCP_SERVERS) {
    invalid(
      `mcpServers has ${names.length} servers; at most ${MAX_CLAUDE_MCP_SERVERS} are allowed.`,
    );
  }
  const folded = new Set<string>();
  const out: CheckedMcpServer[] = [];
  for (const name of names) {
    checkServerName(name, folded);
    out.push(checkServer(name, value[name]));
  }
  return Object.freeze(out);
}

/**
 * Checks one server name against the grammar, the reserved bridge name and
 * the names already seen (case-folded), and records it.
 *
 * @param name - The server name.
 * @param seen - Lowercased names already accepted; updated.
 * @throws ExternalAgentPolicyError `EXTERNAL_AGENT_MCP_SERVER_INVALID`.
 */
export function checkServerName(name: string, seen: Set<string>): void {
  if (name.length > 64 || !CLAUDE_MCP_SERVER_NAME_PATTERN.test(name)) {
    invalid(
      `MCP server name ${quote(name)} must be ASCII letters and digits joined by single '-' or '_', at most 64 characters.`,
    );
  }
  const lower = name.toLowerCase();
  if (lower === BRIDGE_MCP_SERVER) {
    invalid(
      `MCP server name ${quote(name)} is reserved for the bridge's own tools.`,
    );
  }
  if (seen.has(lower)) {
    invalid(`MCP server name ${quote(name)} is listed twice, ignoring case.`);
  }
  seen.add(lower);
}

function checkServer(name: string, server: unknown): CheckedMcpServer {
  if (!isPlainObject(server)) {
    invalid(`MCP server ${name} must be a plain object.`);
  }
  const type = server.type;
  if (type !== "http" && type !== "sse" && type !== "stdio") {
    invalid(`MCP server ${name} must have type "http", "sse" or "stdio".`);
  }
  const allowed = type === "stdio" ? STDIO_KEYS : HTTP_KEYS;
  for (const key of Object.keys(server)) {
    if (!allowed.has(key)) {
      invalid(
        `MCP server ${name} (type ${type}) has the unknown key ${quote(key)}.`,
      );
    }
  }
  const tools = checkTools(name, server.tools);
  const readOnly = server.readOnly;
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    invalid(`MCP server ${name}: readOnly must be a boolean.`);
  }
  if (readOnly === true && (tools === undefined || tools.length === 0)) {
    invalid(
      `MCP server ${name}: readOnly needs a non-empty tools list, so a tool the server adds later is not covered.`,
    );
  }
  const timeoutMs = server.timeoutMs;
  if (
    timeoutMs !== undefined &&
    !(
      typeof timeoutMs === "number" &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 1000 &&
      timeoutMs <= 600_000
    )
  ) {
    invalid(
      `MCP server ${name}: timeoutMs must be an integer from 1000 to 600000.`,
    );
  }
  const common = {
    name,
    ...(tools !== undefined ? { tools } : {}),
    readOnly: readOnly === true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  if (type === "stdio") {
    const command = server.command;
    if (typeof command !== "string" || !isHostAbsolute(command)) {
      invalid(
        `MCP server ${name}: command must be an absolute path to a host executable.`,
      );
    }
    if (CONTROL_CHARACTER.test(command)) {
      invalid(`MCP server ${name}: command has a control character.`);
    }
    const args = server.args;
    if (
      args !== undefined &&
      !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))
    ) {
      invalid(`MCP server ${name}: args must be an array of strings.`);
    }
    const env = checkValues(name, "env", server.env);
    return Object.freeze({
      ...common,
      type,
      command,
      ...(args !== undefined ? { args: Object.freeze([...args]) } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  }
  if (typeof server.url !== "string") {
    invalid(`MCP server ${name}: url must be a string.`);
  }
  const url = parseMcpServerUrl(server.url);
  if (typeof url === "string") {
    invalid(`MCP server ${name}: ${url}`);
  }
  const headers = checkValues(name, "header", server.headers);
  return Object.freeze({
    ...common,
    type,
    url: url.href,
    loopback: url.loopback,
    ...(headers !== undefined ? { headers } : {}),
  });
}

function checkTools(
  name: string,
  tools: unknown,
): readonly string[] | undefined {
  if (tools === undefined) {
    return undefined;
  }
  if (!Array.isArray(tools)) {
    invalid(`MCP server ${name}: tools must be an array of tool names.`);
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (typeof tool !== "string" || !TOOL_NAME_PATTERN.test(tool)) {
      invalid(
        `MCP server ${name}: tool name ${quote(String(tool))} must match ${TOOL_NAME_PATTERN.source} (without the mcp__<server>__ prefix).`,
      );
    }
    if (seen.has(tool)) {
      invalid(`MCP server ${name}: tool ${quote(tool)} is listed twice.`);
    }
    seen.add(tool);
  }
  return Object.freeze([...tools] as string[]);
}

function checkValues(
  server: string,
  field: "header" | "env",
  values: unknown,
): Readonly<Record<string, McpValue>> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const label = field === "header" ? "headers" : "env";
  if (!isPlainObject(values)) {
    invalid(`MCP server ${server}: ${label} must be a plain object.`);
  }
  const out: Record<string, McpValue> = {};
  const seen = new Set<string>();
  for (const key of Object.keys(values)) {
    const pattern = field === "header" ? HEADER_NAME_PATTERN : ENV_NAME_PATTERN;
    if (!pattern.test(key)) {
      invalid(
        `MCP server ${server}: ${field} name ${quote(key)} is not a valid ${field === "header" ? "HTTP header" : "environment variable"} name.`,
      );
    }
    const folded = key.toLowerCase();
    if (seen.has(folded)) {
      invalid(
        `MCP server ${server}: ${field} ${quote(key)} is listed twice, ignoring case.`,
      );
    }
    seen.add(folded);
    out[key] = checkValue(server, field, key, values[key]);
  }
  return Object.freeze(out);
}

function checkValue(
  server: string,
  field: "header" | "env",
  key: string,
  value: unknown,
): McpValue {
  const where = `MCP server ${server}: ${field} ${quote(key)}`;
  if (typeof value === "string") {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MCP_SECRET_LITERAL,
      `ClaudeAgentSdkDriver: ${where} is a bare string. Pass a secret as { resolve } (recommended) or { env }, or mark a value that is not secret as { public: "..." }.`,
    );
  }
  if (!isPlainObject(value)) {
    invalid(`${where} must be { resolve }, { env } or { public }.`);
  }
  const keys = Object.keys(value).sort();
  if ("public" in value) {
    if (keys.length !== 1 || typeof value.public !== "string") {
      invalid(`${where}: a { public } value takes only a string.`);
    }
    if (CONTROL_CHARACTER.test(value.public)) {
      invalid(`${where}: the value has a control character.`);
    }
    if (isSensitiveMcpValueName(key)) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MCP_SECRET_LITERAL,
        `ClaudeAgentSdkDriver: ${where} looks secret, so it cannot be { public }. Pass it as { resolve } (recommended) or { env }.`,
      );
    }
    return Object.freeze({ public: value.public });
  }
  const prefix = value.prefix;
  if (
    prefix !== undefined &&
    (typeof prefix !== "string" ||
      prefix.length > 64 ||
      CONTROL_CHARACTER.test(prefix))
  ) {
    invalid(
      `${where}: prefix must be a string of at most 64 characters with no control character.`,
    );
  }
  const extra = keys.filter((k) => k !== "prefix");
  if (extra.length === 1 && extra[0] === "resolve") {
    if (typeof value.resolve !== "function") {
      invalid(`${where}: resolve must be a function.`);
    }
    return Object.freeze({
      resolve: value.resolve as McpSecretResolver,
      ...(prefix !== undefined ? { prefix } : {}),
    });
  }
  if (extra.length === 1 && extra[0] === "env") {
    if (typeof value.env !== "string" || !ENV_NAME_PATTERN.test(value.env)) {
      invalid(`${where}: env must name an environment variable.`);
    }
    return Object.freeze({
      env: value.env,
      ...(prefix !== undefined ? { prefix } : {}),
    });
  }
  invalid(`${where} must be { resolve }, { env } or { public }.`);
}

function isHostAbsolute(path: string): boolean {
  return process.platform === "win32"
    ? win32.isAbsolute(path)
    : isAbsolute(path);
}

// No leading zeros, no octal, hex or short forms.
const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const PORT = "(?::([1-9][0-9]{0,4}))?";
const PATH = "(/[^?#%\\s]*)?";
const LOOPBACK_URL = new RegExp(
  `^https?://(127\\.${OCTET}\\.${OCTET}\\.${OCTET}|\\[::1\\])${PORT}${PATH}$`,
  "u",
);
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`, "u");
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, "u");
const REMOTE_URL = new RegExp(
  `^https://(\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9.-]+)${PORT}${PATH}$`,
  "u",
);

/**
 * Parses a declared server URL with the raw grammar first, then a WHATWG
 * parse that must give exactly the host the grammar matched.
 *
 * @remarks Loopback is only `127.D.D.D` (no leading zeros) or `[::1]`, over
 * `http` or `https`; nothing is resolved, so a name never counts as
 * loopback. Anything else must be `https` with a host name, a public-form
 * IPv4 literal or a WHATWG-serialized IPv6 literal. Refused everywhere:
 * user info, `%`, whitespace, a query, a fragment, a trailing dot, port 0 or
 * above 65535, `localhost` names, `0.0.0.0/8`, `[::]` and IPv6 forms that
 * map to IPv4.
 *
 * @param given - The URL as configured.
 * @returns The canonical `href` and whether it is loopback, or the reason
 * it was refused.
 */
export function parseMcpServerUrl(
  given: string,
): { href: string; loopback: boolean } | string {
  const loopback = LOOPBACK_URL.exec(given);
  const remote = loopback ? null : REMOTE_URL.exec(given);
  const match = loopback ?? remote;
  if (!match) {
    return /^http:\/\//iu.test(given)
      ? "url must be https unless it is a loopback literal (127.x.x.x or [::1]) with no user, query, fragment or %."
      : "url must be https://<host>[:port][/path], or http on a loopback literal (127.x.x.x or [::1]); no user, query, fragment or %.";
  }
  const host = match[1] ?? "";
  const port = match[2];
  if (port !== undefined && Number(port) > 65535) {
    return "url port must be from 1 to 65535.";
  }
  let parsed: URL;
  try {
    parsed = new URL(given);
  } catch {
    return "url does not parse.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "url must not have a user or password.";
  }
  if (loopback) {
    if (parsed.hostname !== host) {
      return "url host must be a loopback literal exactly as written.";
    }
    return { href: parsed.href, loopback: true };
  }
  const lower = host.toLowerCase();
  if (lower.startsWith("[")) {
    if (parsed.hostname !== host) {
      return "url IPv6 host must be written in its canonical form (lowercase, zeros compressed).";
    }
    const address = host.slice(1, -1);
    if (/^::(?:ffff:)?(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)?$/u.test(address)) {
      return "url IPv6 host must not be unspecified, loopback or an IPv4-mapped address.";
    }
    return { href: parsed.href, loopback: false };
  }
  if (IPV4.test(lower)) {
    const first = Number(lower.split(".")[0]);
    if (first === 127 || first === 0) {
      return "url host 127.x.x.x is loopback (use http://127.x.x.x) and 0.x.x.x is not an address.";
    }
  } else if (
    !HOSTNAME.test(lower) ||
    lower === "localhost" ||
    lower.endsWith(".localhost")
  ) {
    return "url host must be a DNS name (not localhost), an IPv4 literal or a bracketed IPv6 literal, with no trailing dot.";
  }
  if (parsed.hostname !== lower) {
    return "url host must parse to itself (no numeric, hex or short IPv4 forms).";
  }
  return { href: parsed.href, loopback: false };
}

/**
 * Package launchers: they fetch or resolve code at start, which the host has
 * not vetted. Matched on the command's base name, lowercased, without a
 * Windows extension.
 */
export const MCP_STDIO_LAUNCHERS: ReadonlySet<string> = new Set([
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "bunx",
  "bun",
  "uvx",
  "uv",
  "pipx",
  "deno",
]);

/**
 * Environment variables that load code into a stdio server or change which
 * program runs, refused whatever the value. Matched ignoring case, since
 * Windows environment names are. Reviewed for 0.7.0.
 */
export const MCP_STDIO_CODE_ENV_NAMES: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONUSERBASE",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "BASH_ENV",
  "ENV",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  "LUA_PATH",
  "LUA_CPATH",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_GEMFILE",
  "DENO_DIR",
  "BUN_INSTALL",
  "PATH",
]);

/** Prefixes of refused environment variable names (dynamic loader, git). */
export const MCP_STDIO_CODE_ENV_PREFIXES: readonly string[] = Object.freeze([
  "LD_",
  "DYLD_",
  "GIT_",
]);

/**
 * Single-letter flags that load or run code (`python -m`, `perl -M`,
 * `node -r`, `-e`, `-c`, `-p`). Refused alone and in attached form.
 */
const CODE_SHORT_FLAGS: ReadonlySet<string> = new Set([
  "m",
  "M",
  "r",
  "e",
  "c",
  "p",
]);

/** Long flags that load code or open a debugger, alone or with `=`. */
const CODE_LONG_FLAGS: ReadonlySet<string> = new Set([
  "--require",
  "--eval",
  "--print",
  "--import",
  "--loader",
  "--experimental-loader",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--inspect-wait",
]);

/**
 * Whether an env variable name loads code into a stdio server.
 *
 * @param name - The variable name.
 * @returns True when it is refused.
 */
export function isCodeLoadingEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    MCP_STDIO_CODE_ENV_NAMES.has(upper) ||
    MCP_STDIO_CODE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

function stdioUnsafe(server: string, message: string): never {
  throw new ExternalAgentPolicyError(
    EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
    `ClaudeAgentSdkDriver: MCP server ${server}: ${message} A stdio server must be host code the agent cannot change; wrap anything else in a host script at an absolute path.`,
  );
}

/**
 * Checks one stdio argument's form, without the file system.
 *
 * @param arg - The argument.
 * @returns The absolute path in it to root-check (the argument itself, or
 * the value of `--flag=<path>`), `undefined` when there is none, or the
 * reason it is refused.
 */
export function stdioArgForm(
  arg: string,
): { path?: string } | { refused: string } {
  if (CONTROL_CHARACTER.test(arg)) {
    return { refused: "has a control character" };
  }
  if (arg === "-") {
    return { refused: "reads code from stdin" };
  }
  if (!arg.startsWith("-")) {
    if (isHostAbsolute(arg)) {
      return { path: arg };
    }
    return {
      refused:
        "is neither a flag nor an absolute path (a relative script or a separate flag value)",
    };
  }
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (CODE_LONG_FLAGS.has(flag) || flag.startsWith("--inspect")) {
      return { refused: "loads code or opens a debugger" };
    }
    if (eq < 0) {
      return /[/\\]/u.test(arg) ? { refused: "has a path in a flag name" } : {};
    }
    const value = arg.slice(eq + 1);
    if (/[/\\]/u.test(value)) {
      return isHostAbsolute(value)
        ? { path: value }
        : { refused: "has a relative path value" };
    }
    return {};
  }
  // A single-dash argument: one letter only. CLIs read `-abc` as a cluster
  // (`python -Ec<code>`), so longer forms and attached values are refused.
  const letter = arg.slice(1);
  if (letter.length !== 1) {
    return {
      refused:
        "is a single-dash flag with more than one letter (a cluster or an attached value); use --flag=value",
    };
  }
  if (CODE_SHORT_FLAGS.has(letter)) {
    return { refused: "loads or runs code" };
  }
  return /[/\\]/u.test(letter) ? { refused: "has a path in a flag" } : {};
}

/**
 * The run-time checks of one stdio server: command, arguments and env names.
 * Returns the server with its command and absolute path arguments replaced
 * by their real paths, so a later respawn cannot follow a swapped symlink.
 *
 * @param server - Name, command, args and env names of the server.
 * @param roots - Canonical roots the agent can write, and sandbox temp roots.
 * @returns The real command and arguments.
 * @throws ExternalAgentPolicyError `EXTERNAL_AGENT_MCP_STDIO_UNSAFE`.
 */
export function checkStdioServerForRun(
  server: {
    name: string;
    command: string;
    args?: readonly string[];
    envNames?: readonly string[];
  },
  roots: readonly string[],
): { command: string; args: string[] } {
  const { name } = server;
  for (const envName of server.envNames ?? []) {
    if (isCodeLoadingEnvName(envName)) {
      stdioUnsafe(name, `env ${quote(envName)} can load code into the server.`);
    }
  }
  let command: string;
  try {
    command = realpathSync.native(server.command);
  } catch {
    stdioUnsafe(name, "command does not exist or cannot be resolved.");
  }
  let executable = false;
  try {
    const stats = statSync(command);
    executable =
      stats.isFile() &&
      (process.platform === "win32" || (stats.mode & 0o111) !== 0);
  } catch {
    executable = false;
  }
  if (!executable) {
    stdioUnsafe(name, "command is not a regular executable file.");
  }
  if (isUnderAny(command, roots)) {
    stdioUnsafe(
      name,
      "command is inside a directory the agent can write (working directory, allowedPaths or a temp directory).",
    );
  }
  const base = basename(command)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/u, "");
  if (MCP_STDIO_LAUNCHERS.has(base)) {
    stdioUnsafe(
      name,
      `command is the package launcher ${quote(base)}, which fetches or resolves code at start.`,
    );
  }
  const args: string[] = [];
  for (const arg of server.args ?? []) {
    const form = stdioArgForm(arg);
    if ("refused" in form) {
      stdioUnsafe(name, `argument ${quote(arg)} ${form.refused}.`);
    }
    if (form.path === undefined) {
      args.push(arg);
      continue;
    }
    let real: string;
    try {
      real = realpathSync.native(form.path);
    } catch {
      stdioUnsafe(
        name,
        `argument ${quote(arg)} names a path that does not exist.`,
      );
    }
    if (isUnderAny(real, roots)) {
      stdioUnsafe(
        name,
        `argument ${quote(arg)} names a path inside a directory the agent can write.`,
      );
    }
    args.push(
      arg === form.path ? real : `${arg.slice(0, arg.indexOf("=") + 1)}${real}`,
    );
  }
  return { command, args };
}

/**
 * The run-time network check: an http or sse server off loopback needs a
 * policy with `allowNetwork: true`.
 *
 * @param servers - The checked servers.
 * @param policy - The run's permission policy.
 * @throws ExternalAgentPolicyError
 * `EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED`, naming the first such server.
 */
export function checkMcpServerNetwork(
  servers: readonly CheckedMcpServer[],
  policy: ExternalAgentPermissionPolicy | undefined,
): void {
  if (networkAllowed(policy)) {
    return;
  }
  for (const server of servers) {
    if (server.type !== "stdio" && !server.loopback) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED,
        `ClaudeAgentSdkDriver: MCP server ${server.name} is not on loopback, and the policy does not set allowNetwork: true. Set allowNetwork: true, or run the server (or a proxy to it) on 127.0.0.1.`,
      );
    }
  }
}

/**
 * Picks the MCP servers a run spec grants from the host's registry.
 *
 * @remarks Ids match exactly (case included), as own keys of `providers`.
 * The result holds only the granted servers, in grant order; a repeated id
 * is taken once.
 *
 * @param grant - Provider ids, for example a run spec agent's `mcp`.
 * @param providers - The host's servers by provider id.
 * @returns The granted servers, ready for the driver's `mcpServers`.
 * @throws ExternalAgentPolicyError `EXTERNAL_AGENT_MCP_PROVIDER_UNKNOWN`
 * for an id with no entry.
 * @experimental
 */
export function selectMcpServers(
  grant: readonly string[],
  providers: Readonly<Record<string, ClaudeMcpServer>>,
): Record<string, ClaudeMcpServer> {
  const out: Record<string, ClaudeMcpServer> = {};
  for (const id of grant) {
    const server = Object.hasOwn(providers, id) ? providers[id] : undefined;
    if (server === undefined) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MCP_PROVIDER_UNKNOWN,
        `selectMcpServers: no MCP provider ${quote(id)} in the host's registry.`,
      );
    }
    out[id] = server;
  }
  return out;
}
