import { isAbsolute } from "node:path";
import type {
  BaseWorkflowCheckpointStore,
  BaseWorkflowCheckpointStoreOptions,
} from "./checkpoint-store.js";
import { WorkflowStorageError } from "./errors.js";
import type {
  BaseWorkflowEventExporter,
  BaseWorkflowEventExporterOptions,
} from "./event-exporter.js";
import type { WorkflowStorageCapability } from "./support.js";

/**
 * URI schemes with a built-in checkpoint provider.
 *
 * - `memory://`: `InMemoryWorkflowCheckpointStore`.
 * - `file:///absolute/root`: `FileSystemWorkflowCheckpointProvider`.
 * - `sqlite:///absolute/path.db`: `SqliteWorkflowCheckpointStore`, loaded
 *   from `adk-llm-bridge/workflows/checkpoint/sqlite` on first use.
 * - `adk-session+<uri>`: `AdkSessionServiceWorkflowCheckpointStore` over the
 *   service ADK's `getSessionServiceFromUri` returns for `<uri>`.
 * - `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `mssql://`,
 *   `vertexai://`: the same as `adk-session+` with that URI.
 */
export const WORKFLOW_CHECKPOINT_URI_SCHEMES: readonly string[] = Object.freeze(
  [
    "memory",
    "file",
    "sqlite",
    "adk-session+memory",
    "adk-session+sqlite",
    "adk-session+postgres",
    "adk-session+postgresql",
    "adk-session+mysql",
    "adk-session+mariadb",
    "adk-session+mssql",
    "adk-session+vertexai",
    "postgres",
    "postgresql",
    "mysql",
    "mariadb",
    "mssql",
    "vertexai",
  ],
);

/**
 * URI schemes with a built-in event exporter.
 *
 * - `memory://`: `InMemoryWorkflowEventExporter`.
 * - `file:///absolute/directory`: `JsonlWorkflowEventExporter`.
 * - `sqlite:///absolute/path.db`: `SqliteWorkflowEventExporter`, loaded from
 *   `adk-llm-bridge/workflows/events/sqlite` on first use.
 */
export const WORKFLOW_EVENT_URI_SCHEMES: readonly string[] = Object.freeze([
  "memory",
  "file",
  "sqlite",
]);

/**
 * A parsed storage URI, as a provider factory receives it.
 *
 * @experimental
 */
export interface WorkflowStorageUri {
  /** The URI as given. It can hold a password: log `redacted` instead. */
  readonly uri: string;
  /** The URI with any password replaced by `***`. */
  readonly redacted: string;
  /** Lower-case scheme without `://`, for example `sqlite`. */
  readonly scheme: string;
  /**
   * Everything after `scheme://` and before `?`, percent-decoded: for
   * `sqlite:///var/db/x.db` it is `/var/db/x.db`.
   */
  readonly path: string;
  /** Query parameters. */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Creates the providers of one URI scheme. A factory implements the
 * capabilities its storage serves.
 *
 * @experimental
 */
export interface WorkflowStorageProviderFactory {
  /**
   * Creates a checkpoint provider.
   *
   * @param uri - The parsed URI.
   * @param options - Options given to the registry call.
   * @returns The provider.
   */
  checkpointStore?(
    uri: WorkflowStorageUri,
    options: BaseWorkflowCheckpointStoreOptions,
  ): BaseWorkflowCheckpointStore | Promise<BaseWorkflowCheckpointStore>;
  /**
   * Creates an event exporter.
   *
   * @param uri - The parsed URI.
   * @param options - Options given to the registry call.
   * @returns The exporter.
   */
  eventExporter?(
    uri: WorkflowStorageUri,
    options: BaseWorkflowEventExporterOptions,
  ): BaseWorkflowEventExporter | Promise<BaseWorkflowEventExporter>;
}

/**
 * One registered scheme.
 *
 * @experimental
 */
export interface WorkflowStorageSchemeInfo {
  /** Lower-case scheme. */
  scheme: string;
  /** Capabilities the scheme's factory serves. */
  capabilities: readonly WorkflowStorageCapability[];
  /** `true` for the schemes this package registers itself. */
  builtIn: boolean;
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;
/**
 * Longest storage URI, in characters, the registry parses; a longer one is
 * rejected with `WORKFLOW_STORAGE_INVALID_URI` before any parsing.
 *
 * @experimental
 */
export const MAX_WORKFLOW_STORAGE_URI_LENGTH = 8192;
const URI_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/;
const ADK_SESSION_PREFIX = "adk-session+";
const INVALID_URI_PLACEHOLDER = "<invalid uri>";
// Matched against the parameter name in lower case without separators, so
// `api_key`, `apiKey`, `access_token`, `secret_access_key` and `sslpassword`
// are all redacted; a false positive only hides a harmless value.
const SECRET_QUERY_KEY_PATTERN =
  /pass|pwd|secret|token|key|auth|credential|signature|sig$|cert/;
const ADK_DATABASE_SCHEMES = [
  "postgres",
  "postgresql",
  "mysql",
  "mariadb",
  "mssql",
  "vertexai",
] as const;

/**
 * Replaces the password of a URI by `***`, for logs and error messages.
 *
 * @param uri - Any storage URI.
 * @returns The URI without its password; a string that is not a URI is
 * returned as `<invalid uri>`.
 *
 * @experimental
 */
export function redactWorkflowStorageUri(uri: string): string {
  if (typeof uri !== "string" || uri.length > MAX_WORKFLOW_STORAGE_URI_LENGTH) {
    return INVALID_URI_PLACEHOLDER;
  }
  const match = URI_PATTERN.exec(uri);
  if (match === null) return INVALID_URI_PLACEHOLDER;
  const scheme = match[1] as string;
  let rest = match[2] as string;
  // A password may itself hold '/', '?', '#' or '@', so the user info runs
  // from the start to the last '@' whenever the user name (before the first
  // ':') holds no delimiter. When a later '@' sits in the path or the query,
  // more than the password is hidden, which is the safe direction.
  let userInfo = "";
  const at = rest.lastIndexOf("@");
  const colon = rest.indexOf(":");
  if (at !== -1 && colon !== -1 && colon < at) {
    const user = rest.slice(0, colon);
    if (!/[/?#]/.test(user)) {
      userInfo = `${user}:***@`;
      rest = rest.slice(at + 1);
    }
  }
  const queryStart = rest.search(/[?#]/);
  const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
  let query = "";
  if (queryStart !== -1) {
    const tail = rest.slice(queryStart);
    const hashStart = tail.indexOf("#");
    const pairs =
      hashStart === 0
        ? ""
        : tail.slice(0, hashStart === -1 ? undefined : hashStart);
    const fragment = hashStart === -1 ? "" : "#***";
    query = `${redactQueryPairs(pairs)}${fragment}`;
  }
  return `${scheme}://${userInfo}${beforeQuery}${query}`;
}

// Linear: one split and one indexOf per pair, so no input backtracks.
function redactQueryPairs(query: string): string {
  if (query === "") return "";
  const pairs = query.slice(1).split("&");
  const redacted = pairs.map((pair) => {
    const equals = pair.indexOf("=");
    if (equals <= 0) return pair;
    const key = pair.slice(0, equals);
    return isSecretQueryKey(key) ? `${key}=***` : pair;
  });
  return `${query[0]}${redacted.join("&")}`;
}

function isSecretQueryKey(key: string): boolean {
  let name = key;
  try {
    name = decodeURIComponent(key);
  } catch {
    // An undecodable name is matched as written.
  }
  return SECRET_QUERY_KEY_PATTERN.test(
    name.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
}

interface RegistryEntry {
  readonly scheme: string;
  readonly factory: WorkflowStorageProviderFactory;
  readonly builtIn: boolean;
  readonly previous: RegistryEntry | undefined;
  removed: boolean;
}

const registry = new Map<string, RegistryEntry>();

function invalidUri(
  uri: string,
  reason: string,
  details: Record<string, unknown> = {},
): WorkflowStorageError {
  const redacted = redactWorkflowStorageUri(uri);
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_INVALID_URI",
    `Invalid workflow storage URI ${redacted}: ${reason}`,
    { details: { uri: redacted, ...details } },
  );
}

/**
 * Registers the provider factory of a URI scheme, so the host can add its
 * own storage (for example `dynamodb://`) or replace a built-in one.
 *
 * @remarks
 * The registry is one per process and shared by every entry point of the
 * package.
 *
 * @param scheme - Scheme without `://`: a letter followed by letters,
 * digits, `+`, `-` or `.`; compared in lower case.
 * @param factory - Creates the providers of the scheme.
 * @param options - Pass `replace: true` to replace a registered scheme.
 * @returns A function that removes this registration and restores the one it
 * replaced.
 * @throws `WorkflowStorageError` with code
 * `WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED` when the scheme is taken and
 * `replace` is not set, or `WORKFLOW_STORAGE_INVALID_URI` for a bad scheme.
 *
 * @example
 * ```ts
 * registerWorkflowStorageProvider("dynamodb", {
 *   checkpointStore: (uri, options) => new DynamoCheckpointStore({ table: uri.path, ...options }),
 * });
 * const store = await getWorkflowCheckpointStoreFromUri("dynamodb://workflow-checkpoints");
 * ```
 *
 * @experimental
 */
export function registerWorkflowStorageProvider(
  scheme: string,
  factory: WorkflowStorageProviderFactory,
  options: { replace?: boolean } = {},
): () => void {
  if (typeof scheme !== "string" || !SCHEME_PATTERN.test(scheme)) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_URI",
      "A storage scheme must start with a letter and use only letters, digits, '+', '-' and '.'",
      { details: { scheme: String(scheme).slice(0, 64) } },
    );
  }
  const name = scheme.toLowerCase();
  const existing = registry.get(name);
  if (existing !== undefined && options.replace !== true) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED",
      `A storage provider is already registered for scheme "${name}"; pass { replace: true } to replace it`,
      { details: { scheme: name } },
    );
  }
  const entry: RegistryEntry = {
    scheme: name,
    factory,
    builtIn: false,
    previous: existing,
    removed: false,
  };
  registry.set(name, entry);
  return () => {
    if (entry.removed) return;
    entry.removed = true;
    if (registry.get(name) !== entry) return;
    let restore = entry.previous;
    while (restore?.removed) restore = restore.previous;
    if (restore === undefined) registry.delete(name);
    else registry.set(name, restore);
  };
}

/**
 * Lists the registered schemes, built-in and custom.
 *
 * @returns One entry per scheme, sorted by scheme.
 *
 * @experimental
 */
export function listWorkflowStorageSchemes(): WorkflowStorageSchemeInfo[] {
  return [...registry.values()]
    .map((entry) => {
      const capabilities: WorkflowStorageCapability[] = [];
      if (entry.factory.checkpointStore !== undefined) {
        capabilities.push("checkpoints");
      }
      if (entry.factory.eventExporter !== undefined) {
        capabilities.push("events");
      }
      return { scheme: entry.scheme, capabilities, builtIn: entry.builtIn };
    })
    .sort((a, b) => (a.scheme < b.scheme ? -1 : a.scheme > b.scheme ? 1 : 0));
}

function parseWorkflowStorageUri(uri: string): WorkflowStorageUri {
  if (typeof uri === "string" && uri.length > MAX_WORKFLOW_STORAGE_URI_LENGTH) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_URI",
      `Invalid workflow storage URI: it is ${uri.length} characters long and the limit is ${MAX_WORKFLOW_STORAGE_URI_LENGTH}`,
      {
        details: {
          uri: INVALID_URI_PLACEHOLDER,
          maxLength: MAX_WORKFLOW_STORAGE_URI_LENGTH,
        },
      },
    );
  }
  const match = typeof uri === "string" ? URI_PATTERN.exec(uri) : null;
  if (match === null) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_URI",
      "Invalid workflow storage URI: expected scheme://...",
      { details: { uri: INVALID_URI_PLACEHOLDER } },
    );
  }
  const scheme = (match[1] as string).toLowerCase();
  const rest = match[2] as string;
  const hashStart = rest.indexOf("#");
  const withoutFragment = hashStart === -1 ? rest : rest.slice(0, hashStart);
  const queryStart = withoutFragment.indexOf("?");
  const rawPath =
    queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart);
  const rawQuery =
    queryStart === -1 ? "" : withoutFragment.slice(queryStart + 1);
  let path: string;
  // A null prototype keeps `__proto__` an ordinary key, so it is listed and
  // rejected as an unknown parameter instead of changing the prototype.
  const params: Record<string, string> = Object.create(null);
  try {
    path = decodeURIComponent(rawPath);
    if (rawQuery !== "") {
      for (const pair of rawQuery.split("&")) {
        if (pair === "") continue;
        const equals = pair.indexOf("=");
        const key = decodeURIComponent(
          (equals === -1 ? pair : pair.slice(0, equals)).replace(/\+/g, " "),
        );
        const value =
          equals === -1
            ? ""
            : decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, " "));
        if (key === "" || Object.hasOwn(params, key)) {
          throw invalidUri(uri, `bad or repeated query parameter "${key}"`);
        }
        params[key] = value;
      }
    }
  } catch (error) {
    if (error instanceof WorkflowStorageError) throw error;
    throw invalidUri(uri, "it holds a bad percent-encoding");
  }
  return Object.freeze({
    uri,
    redacted: redactWorkflowStorageUri(uri),
    scheme,
    path,
    params: Object.freeze(params),
  });
}

type ParamSpec =
  | { kind: "integer"; min: number; max?: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "boolean" }
  | { kind: "string" };

type ParamSpecs = Readonly<Record<string, ParamSpec>>;

const POSITIVE: ParamSpec = { kind: "integer", min: 1 };
const CHECKPOINT_BASE_PARAMS: ParamSpecs = {
  maxCheckpointBytes: POSITIVE,
  operationTimeoutMs: POSITIVE,
};
const EVENT_BASE_PARAMS: ParamSpecs = { maxRecordBytes: POSITIVE };
const SQLITE_PARAMS: ParamSpecs = {
  busyTimeoutMs: { kind: "integer", min: 0, max: 2_147_483_647 },
  synchronous: { kind: "enum", values: ["full", "normal"] },
};

function readParams(
  uri: WorkflowStorageUri,
  specs: ParamSpecs,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(uri.params)) {
    const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (spec === undefined) {
      throw invalidUri(
        uri.uri,
        `unknown query parameter "${name}" for scheme "${uri.scheme}" (accepted: ${Object.keys(specs).join(", ") || "none"})`,
        { parameter: name },
      );
    }
    const bad = (expected: string): WorkflowStorageError =>
      invalidUri(uri.uri, `query parameter "${name}" must be ${expected}`, {
        parameter: name,
      });
    switch (spec.kind) {
      case "integer": {
        const number = /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
        if (
          !Number.isSafeInteger(number) ||
          number < spec.min ||
          (spec.max !== undefined && number > spec.max)
        ) {
          throw bad(
            `an integer from ${spec.min}${spec.max === undefined ? "" : ` to ${spec.max}`}`,
          );
        }
        result[name] = number;
        break;
      }
      case "enum":
        if (!spec.values.includes(value)) {
          throw bad(`one of ${spec.values.join(", ")}`);
        }
        result[name] = value;
        break;
      case "boolean":
        if (value !== "true" && value !== "false") {
          throw bad("true or false");
        }
        result[name] = value === "true";
        break;
      case "string":
        if (value === "") throw bad("not empty");
        result[name] = value;
        break;
    }
  }
  return result;
}

function definedOptions<T extends object>(options: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(options) as Array<keyof T>) {
    if (options[key] !== undefined) result[key] = options[key];
  }
  return result;
}

/**
 * Turns the URL form of a Windows drive path (`/C:/dir`) into the path
 * Windows opens (`C:/dir`); any other path is returned as it is.
 *
 * @internal
 */
export function windowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function requireAbsolutePath(
  uri: WorkflowStorageUri,
  allowMemoryDatabase = false,
): string {
  if (allowMemoryDatabase && uri.path === ":memory:") return uri.path;
  const path =
    process.platform === "win32" ? windowsDrivePath(uri.path) : uri.path;
  if (path === "" || !isAbsolute(path)) {
    throw invalidUri(
      uri.uri,
      `scheme "${uri.scheme}" needs an absolute path, for example ${uri.scheme}:///var/lib/app/data`,
    );
  }
  if (path.includes("\0")) {
    throw invalidUri(uri.uri, "the path holds a NUL byte");
  }
  // Percent-encoded dot segments decode to '..' and would resolve outside
  // the directory the URI names; the path must be written in final form.
  if (path.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw invalidUri(
      uri.uri,
      "the path holds a '.' or '..' segment; write the resolved path",
    );
  }
  return path;
}

function requireNoPath(uri: WorkflowStorageUri): void {
  if (uri.path !== "") {
    throw invalidUri(uri.uri, `scheme "${uri.scheme}" takes no path`);
  }
}

function driverMissing(
  uri: WorkflowStorageUri,
  driver: string,
  cause: unknown,
): WorkflowStorageError {
  const causeText = cause instanceof Error ? cause.message : String(cause);
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_DRIVER_MISSING",
    `The storage driver "${driver}" for ${uri.redacted} is not available`,
    {
      details: { uri: uri.redacted, driver },
      ...(causeText.includes(uri.uri) ? {} : { cause }),
    },
  );
}

async function loadModule<T>(
  uri: WorkflowStorageUri,
  driver: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    throw driverMissing(uri, driver, error);
  }
}

const MODULE_NOT_FOUND =
  /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|Cannot find module/i;

function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    (typeof code === "string" && MODULE_NOT_FOUND.test(code)) ||
    (typeof message === "string" && MODULE_NOT_FOUND.test(message))
  );
}

function driverName(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String((error as unknown) ?? "");
  const open = message.search(/['"`]/);
  if (open === -1 || open > MAX_WORKFLOW_STORAGE_URI_LENGTH)
    return "@google/adk";
  const close = message.slice(open + 1).search(/['"`]/);
  return close > 0 ? message.slice(open + 1, open + 1 + close) : "@google/adk";
}

const memoryFactory: WorkflowStorageProviderFactory = {
  async checkpointStore(uri, options) {
    requireNoPath(uri);
    const params = readParams(uri, {
      ...CHECKPOINT_BASE_PARAMS,
      maxCheckpoints: POSITIVE,
    });
    const { InMemoryWorkflowCheckpointStore } = await loadModule(
      uri,
      "adk-llm-bridge/workflows",
      () => import("./in-memory-checkpoint-store.js"),
    );
    return new InMemoryWorkflowCheckpointStore({
      ...params,
      ...definedOptions(options),
    });
  },
  async eventExporter(uri, options) {
    requireNoPath(uri);
    const params = readParams(uri, {
      ...EVENT_BASE_PARAMS,
      maxRecords: POSITIVE,
    });
    const { InMemoryWorkflowEventExporter } = await loadModule(
      uri,
      "adk-llm-bridge/workflows",
      () => import("./in-memory-event-exporter.js"),
    );
    return new InMemoryWorkflowEventExporter({
      ...params,
      ...definedOptions(options),
    });
  },
};

const fileFactory: WorkflowStorageProviderFactory = {
  async checkpointStore(uri, options) {
    const root = requireAbsolutePath(uri);
    const params = readParams(uri, {
      ...CHECKPOINT_BASE_PARAMS,
      lockTimeoutMs: POSITIVE,
      lockRetryMs: POSITIVE,
    });
    const { FileSystemWorkflowCheckpointProvider } = await loadModule(
      uri,
      "adk-llm-bridge/workflows",
      () => import("./file-system-checkpoint-provider.js"),
    );
    return new FileSystemWorkflowCheckpointProvider({
      ...params,
      ...definedOptions(options),
      root,
    });
  },
  async eventExporter(uri, options) {
    const directory = requireAbsolutePath(uri);
    const params = readParams(uri, {
      ...EVENT_BASE_PARAMS,
      sync: { kind: "enum", values: ["batch", "none"] },
    });
    const { JsonlWorkflowEventExporter } = await loadModule(
      uri,
      "adk-llm-bridge/workflows",
      () => import("./jsonl-event-exporter.js"),
    );
    return new JsonlWorkflowEventExporter({
      ...params,
      ...definedOptions(options),
      directory,
    });
  },
};

const sqliteFactory: WorkflowStorageProviderFactory = {
  async checkpointStore(uri, options) {
    const path = requireAbsolutePath(uri, true);
    const params = readParams(uri, {
      ...CHECKPOINT_BASE_PARAMS,
      ...SQLITE_PARAMS,
    });
    const { SqliteWorkflowCheckpointStore } = await loadModule(
      uri,
      "sqlite (node:sqlite)",
      () => import("../checkpoint/sqlite/index.js"),
    );
    return new SqliteWorkflowCheckpointStore({
      ...params,
      ...definedOptions(options),
      path,
    });
  },
  async eventExporter(uri, options) {
    const path = requireAbsolutePath(uri, true);
    const params = readParams(uri, { ...EVENT_BASE_PARAMS, ...SQLITE_PARAMS });
    const { SqliteWorkflowEventExporter } = await loadModule(
      uri,
      "sqlite (node:sqlite)",
      () => import("../events/sqlite/index.js"),
    );
    return new SqliteWorkflowEventExporter({
      ...params,
      ...definedOptions(options),
      path,
    });
  },
};

const ADK_SESSION_PARAMS: ParamSpecs = {
  ...CHECKPOINT_BASE_PARAMS,
  appName: { kind: "string" },
  concurrency: { kind: "enum", values: ["stale-session-reject", "none"] },
  durable: { kind: "boolean" },
};

/** Removes the provider's own query parameters from the URI ADK receives. */
function adkSessionUri(uri: WorkflowStorageUri, prefixed: boolean): string {
  const full = prefixed ? uri.uri.slice(ADK_SESSION_PREFIX.length) : uri.uri;
  const queryStart = full.indexOf("?");
  if (queryStart === -1) return full;
  const kept = full
    .slice(queryStart + 1)
    .split("&")
    .filter((pair) => {
      const equals = pair.indexOf("=");
      const key = equals === -1 ? pair : pair.slice(0, equals);
      return !Object.hasOwn(ADK_SESSION_PARAMS, key);
    });
  const base = full.slice(0, queryStart);
  return kept.length === 0 ? base : `${base}?${kept.join("&")}`;
}

function adkSessionFactory(prefixed: boolean): WorkflowStorageProviderFactory {
  return {
    async checkpointStore(uri, options) {
      const params = readParams(uri, ADK_SESSION_PARAMS);
      const adk = await loadModule(
        uri,
        "@google/adk",
        () => import("@google/adk"),
      );
      let sessionService: Awaited<
        ReturnType<typeof adk.getSessionServiceFromUri>
      >;
      try {
        sessionService = adk.getSessionServiceFromUri(
          adkSessionUri(uri, prefixed),
        );
      } catch (error) {
        if (isModuleNotFound(error)) {
          throw driverMissing(uri, driverName(error), error);
        }
        throw invalidUri(
          uri.uri,
          "the ADK session service does not accept this URI",
        );
      }
      const { AdkSessionServiceWorkflowCheckpointStore } = await loadModule(
        uri,
        "adk-llm-bridge/workflows",
        () => import("./adk-session-checkpoint-store.js"),
      );
      return new AdkSessionServiceWorkflowCheckpointStore({
        ...(params as Record<string, never>),
        ...definedOptions(options),
        sessionService,
      });
    },
  };
}

function registerBuiltIn(
  scheme: string,
  factory: WorkflowStorageProviderFactory,
): void {
  registry.set(scheme, {
    scheme,
    factory,
    builtIn: true,
    previous: undefined,
    removed: false,
  });
}

registerBuiltIn("memory", memoryFactory);
registerBuiltIn("file", fileFactory);
registerBuiltIn("sqlite", sqliteFactory);
for (const scheme of WORKFLOW_CHECKPOINT_URI_SCHEMES) {
  if (scheme.startsWith(ADK_SESSION_PREFIX)) {
    registerBuiltIn(scheme, adkSessionFactory(true));
  }
}
for (const scheme of ADK_DATABASE_SCHEMES) {
  registerBuiltIn(scheme, adkSessionFactory(false));
}

function resolveFactory(
  uri: string,
  capability: "checkpointStore" | "eventExporter",
): { parsed: WorkflowStorageUri; factory: WorkflowStorageProviderFactory } {
  const parsed = parseWorkflowStorageUri(uri);
  const entry = registry.get(parsed.scheme);
  if (entry === undefined) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNKNOWN_SCHEME",
      `No workflow storage provider is registered for ${parsed.redacted} (scheme "${parsed.scheme}")`,
      {
        details: {
          uri: parsed.redacted,
          scheme: parsed.scheme,
          registered: [...registry.keys()].sort(),
        },
      },
    );
  }
  if (entry.factory[capability] === undefined) {
    const label =
      capability === "checkpointStore" ? "checkpoint store" : "event exporter";
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNSUPPORTED",
      `The storage scheme "${parsed.scheme}" has no ${label}: ${parsed.redacted}`,
      {
        details: { uri: parsed.redacted, scheme: parsed.scheme },
        capability: capability === "checkpointStore" ? "checkpoints" : "events",
      },
    );
  }
  return { parsed, factory: entry.factory };
}

/**
 * Creates the checkpoint provider a URI names, in the style of ADK's
 * `getSessionServiceFromUri`. See {@link WORKFLOW_CHECKPOINT_URI_SCHEMES}.
 *
 * @remarks
 * Injection comes first: a host that builds its provider itself passes it as
 * `checkpointStore` and needs no URI. The function is asynchronous because
 * providers with a runtime module or an optional peer are imported on first
 * use. It never falls back to another provider: an unknown scheme, a missing
 * driver and an unknown query parameter are errors. Query parameters are the
 * provider's scalar options, for example
 * `sqlite:///var/db/w.db?busyTimeoutMs=10000&synchronous=normal`.
 *
 * @param uri - Storage URI.
 * @param options - Shared provider options; they win over query parameters.
 * @returns The provider. The caller closes it.
 * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_UNKNOWN_SCHEME`,
 * `WORKFLOW_STORAGE_INVALID_URI`, `WORKFLOW_STORAGE_DRIVER_MISSING`, or
 * `WORKFLOW_STORAGE_UNSUPPORTED` when the scheme's factory has no checkpoint
 * provider. Messages show the URI without its password.
 *
 * @experimental
 */
export async function getWorkflowCheckpointStoreFromUri(
  uri: string,
  options: BaseWorkflowCheckpointStoreOptions = {},
): Promise<BaseWorkflowCheckpointStore> {
  const { parsed, factory } = resolveFactory(uri, "checkpointStore");
  return await (
    factory.checkpointStore as NonNullable<
      WorkflowStorageProviderFactory["checkpointStore"]
    >
  )(parsed, options);
}

/**
 * Creates the event exporter a URI names. See
 * {@link WORKFLOW_EVENT_URI_SCHEMES}.
 *
 * @param uri - Storage URI.
 * @param options - Shared exporter options; they win over query parameters.
 * @returns The exporter. The caller closes it.
 * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_UNKNOWN_SCHEME`,
 * `WORKFLOW_STORAGE_INVALID_URI`, `WORKFLOW_STORAGE_DRIVER_MISSING`, or
 * `WORKFLOW_STORAGE_UNSUPPORTED` when the scheme's factory has no event
 * exporter.
 *
 * @experimental
 */
export async function getWorkflowEventExporterFromUri(
  uri: string,
  options: BaseWorkflowEventExporterOptions = {},
): Promise<BaseWorkflowEventExporter> {
  const { parsed, factory } = resolveFactory(uri, "eventExporter");
  return await (
    factory.eventExporter as NonNullable<
      WorkflowStorageProviderFactory["eventExporter"]
    >
  )(parsed, options);
}
