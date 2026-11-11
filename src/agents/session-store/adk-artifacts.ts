import { createHash } from "node:crypto";
import type {
  BaseArtifactService,
  InvocationContext,
  SessionArtifactService,
} from "@google/adk";
import type { SessionKey, SessionStore, SessionStoreEntry } from "./types.js";

/** Codes of {@link AdkArtifactSessionStoreError}. */
export type AdkArtifactSessionStoreErrorCode =
  | "SESSION_STORE_NO_ARTIFACT_SERVICE"
  | "SESSION_STORE_INVALID_KEY"
  | "SESSION_STORE_INVALID_ENTRY"
  | "SESSION_STORE_INVALID_OPTION"
  | "SESSION_STORE_CORRUPT_VERSION";

/**
 * A numeric metadata value: a number, or the decimal string a service such as
 * GCS stores in its place (it stringifies every custom metadata value).
 * Anything else counts as 0.
 */
function metadataNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return 0;
}

/**
 * Error raised by {@link AdkArtifactSessionStore}, discriminated by
 * {@link AdkArtifactSessionStoreErrorCode}.
 *
 * @remarks
 * - `SESSION_STORE_NO_ARTIFACT_SERVICE`: neither the
 *   `artifactService` option nor the invocation context has an artifact
 *   service.
 * - `SESSION_STORE_INVALID_KEY`: an empty `projectKey` or `sessionId`, or an
 *   empty-string `subpath`.
 * - `SESSION_STORE_INVALID_ENTRY`: an entry that is not a JSON object or that
 *   JSON cannot represent.
 * - `SESSION_STORE_INVALID_OPTION`: a `maxVersionBytes` that is not a
 *   positive integer.
 * - `SESSION_STORE_CORRUPT_VERSION`: a stored version that is not JSONL, has
 *   no readable content, or does not carry the `claude-session.v1` format.
 *
 * @experimental
 */
export class AdkArtifactSessionStoreError extends Error {
  /** Machine-readable failure code. */
  readonly code: AdkArtifactSessionStoreErrorCode;

  /**
   * Creates the error.
   *
   * @param code - Failure code.
   * @param message - Human-readable description.
   * @param options - Standard error options; `cause` holds the underlying
   * error.
   */
  constructor(
    code: AdkArtifactSessionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdkArtifactSessionStoreError";
    this.code = code;
  }
}

/** Options of {@link adkArtifactSessionStore}. */
export interface AdkArtifactSessionStoreOptions {
  /**
   * Use this service instead of `context.artifactService`. The scope (app,
   * user, session) still comes from `context.session`.
   */
  artifactService?: BaseArtifactService;
  /**
   * Largest JSONL text written as one artifact version, in UTF-8 bytes; a
   * bigger batch is split into consecutive versions. A single entry over the
   * limit is still written alone. An integer of at least 1.
   *
   * @defaultValue 4194304 (4 MiB)
   */
  maxVersionBytes?: number;
}

/**
 * Builds a {@link SessionStore} for one run from its invocation context.
 *
 * @experimental
 */
export type SessionStoreFactory = (run: {
  context: InvocationContext;
}) => SessionStore;

const FORMAT = "claude-session.v1";
const PREFIX = `${FORMAT}.`;
const MAIN = "main";
const DEFAULT_MAX_VERSION_BYTES = 4 * 1024 * 1024;
const LOAD_CONCURRENCY = 8;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

function checkMaxVersionBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_VERSION_BYTES;
  if (!Number.isInteger(value) || value < 1) {
    throw new AdkArtifactSessionStoreError(
      "SESSION_STORE_INVALID_OPTION",
      `maxVersionBytes must be an integer of at least 1; got ${String(value)}.`,
    );
  }
  return value;
}

function hash32(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function projectPart(projectKey: string): string {
  return hash32(projectKey);
}

function sessionPart(sessionId: string): string {
  return PLAIN_ID.test(sessionId) ? sessionId : `h${hash32(sessionId)}`;
}

function subPart(subpath: string | undefined): string {
  return subpath === undefined
    ? MAIN
    : `s${Buffer.from(subpath, "utf8").toString("base64url")}`;
}

function filenameOf(key: {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}): string {
  return `${PREFIX}${projectPart(key.projectKey)}.${sessionPart(key.sessionId)}.${subPart(key.subpath)}.jsonl`;
}

function checkKey(key: {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}): { projectKey: string; sessionId: string; subpath?: string } {
  const valid =
    typeof key?.projectKey === "string" &&
    key.projectKey !== "" &&
    typeof key.sessionId === "string" &&
    key.sessionId !== "" &&
    (key.subpath === undefined ||
      (typeof key.subpath === "string" && key.subpath !== ""));
  if (!valid) {
    throw new AdkArtifactSessionStoreError(
      "SESSION_STORE_INVALID_KEY",
      "A session key needs a non-empty projectKey and sessionId, and a subpath that is absent or non-empty.",
    );
  }
  return {
    projectKey: key.projectKey,
    sessionId: key.sessionId,
    ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
  };
}

function serialize(entry: SessionStoreEntry, index: number): string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new AdkArtifactSessionStoreError(
      "SESSION_STORE_INVALID_ENTRY",
      `Session store entry ${index} is not a JSON object.`,
    );
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(entry) as string | undefined;
  } catch (error) {
    throw new AdkArtifactSessionStoreError(
      "SESSION_STORE_INVALID_ENTRY",
      `Session store entry ${index} cannot be stored as JSON.`,
      { cause: error },
    );
  }
  if (typeof json !== "string" || !json.startsWith("{")) {
    throw new AdkArtifactSessionStoreError(
      "SESSION_STORE_INVALID_ENTRY",
      `Session store entry ${index} does not serialize to a JSON object.`,
    );
  }
  return json;
}

function chunkLines(lines: string[], maxBytes: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, "utf8");
    if (current.length > 0 && size + 1 + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    size += current.length > 0 ? 1 + bytes : bytes;
    current.push(line);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function corrupt(
  filename: string,
  version: number,
  why: string,
  cause?: unknown,
): AdkArtifactSessionStoreError {
  return new AdkArtifactSessionStoreError(
    "SESSION_STORE_CORRUPT_VERSION",
    `Version ${version} of ${filename} is not a ${FORMAT} transcript: ${why}.`,
    cause === undefined ? undefined : { cause },
  );
}

function parseVersion(
  filename: string,
  version: number,
  text: string,
): SessionStoreEntry[] {
  const entries: SessionStoreEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw corrupt(filename, version, "a line is not JSON", error);
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw corrupt(filename, version, "a line is not a JSON object");
    }
    entries.push(parsed as SessionStoreEntry);
  }
  return entries;
}

/**
 * A Claude Agent SDK session store that keeps each transcript as a versioned
 * artifact of one ADK session.
 *
 * @remarks
 * Every `append` is one `saveArtifact` holding only that batch (split past
 * `maxVersionBytes`); it never reads or rewrites older versions. `load` reads
 * every version in order and applies the `uuid` rule in memory: the first
 * position of a `uuid` is kept and the last value wins, so a retried or late
 * batch costs a version, never a row. Appends and deletes of one transcript
 * are serialized inside the process; two processes writing one ADK session's
 * transcript at once are unsupported. Retention is up to the caller.
 *
 * @experimental Implements the Claude Agent SDK's `@alpha` session store
 * contract.
 */
export class AdkArtifactSessionStore implements SessionStore {
  readonly #service: SessionArtifactService;
  readonly #maxVersionBytes: number;
  readonly #queues = new Map<string, Promise<unknown>>();

  /**
   * @param options - The artifact service, already bound to one ADK session,
   * and the version size limit.
   * @throws {@link AdkArtifactSessionStoreError} with code
   * `SESSION_STORE_INVALID_OPTION` for a bad `maxVersionBytes`.
   */
  constructor(options: {
    artifactService: SessionArtifactService;
    maxVersionBytes?: number;
  }) {
    this.#maxVersionBytes = checkMaxVersionBytes(options.maxVersionBytes);
    this.#service = options.artifactService;
  }

  #serial<T>(filename: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(filename) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.#queues.set(filename, tail);
    void tail.then(() => {
      if (this.#queues.get(filename) === tail) this.#queues.delete(filename);
    });
    return run;
  }

  /**
   * Stores a batch as one new artifact version (several past the size limit).
   *
   * @param key - The transcript.
   * @param entries - The new entries, stored in this order.
   * @throws {@link AdkArtifactSessionStoreError} with code
   * `SESSION_STORE_INVALID_KEY` or `SESSION_STORE_INVALID_ENTRY`; nothing of
   * the batch is stored then. A failing `saveArtifact` rejects with the
   * service's error.
   */
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const checked = checkKey(key);
    const lines = entries.map(serialize);
    if (lines.length === 0) return;
    const filename = filenameOf(checked);
    const chunks = chunkLines(lines, this.#maxVersionBytes);
    await this.#serial(filename, async () => {
      for (const chunk of chunks) {
        await this.#service.saveArtifact({
          filename,
          artifact: { text: chunk.join("\n") },
          customMetadata: {
            format: FORMAT,
            projectKey: checked.projectKey,
            sessionId: checked.sessionId,
            ...(checked.subpath === undefined
              ? {}
              : { subpath: checked.subpath }),
            entries: chunk.length,
            mtime: Date.now(),
          },
        });
      }
    });
  }

  /**
   * Reads a whole transcript.
   *
   * @param key - The transcript.
   * @returns Its entries in append order, or `null` when nothing is stored.
   * @throws {@link AdkArtifactSessionStoreError} with code
   * `SESSION_STORE_INVALID_KEY` or `SESSION_STORE_CORRUPT_VERSION`.
   */
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const filename = filenameOf(checkKey(key));
    const versions = [...(await this.#service.listVersions(filename))].sort(
      (a, b) => a - b,
    );
    if (versions.length === 0) return null;
    const metadata = new Map(
      (await this.#service.listArtifactVersions(filename)).map((item) => [
        item.version,
        item.customMetadata,
      ]),
    );
    for (const version of versions) {
      if (metadata.get(version)?.format !== FORMAT) {
        throw corrupt(filename, version, "wrong or missing format metadata");
      }
    }
    const texts: string[] = new Array(versions.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < versions.length) {
        const index = next++;
        const version = versions[index] as number;
        const part = await this.#service.loadArtifact({ filename, version });
        if (typeof part?.text !== "string") {
          throw corrupt(filename, version, "no readable text content");
        }
        texts[index] = part.text;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(LOAD_CONCURRENCY, versions.length) }, () =>
        worker(),
      ),
    );
    const rows: SessionStoreEntry[] = [];
    const positions = new Map<string, number>();
    versions.forEach((version, index) => {
      for (const entry of parseVersion(
        filename,
        version,
        texts[index] as string,
      )) {
        const uuid =
          typeof entry.uuid === "string" && entry.uuid !== ""
            ? entry.uuid
            : undefined;
        const at = uuid === undefined ? undefined : positions.get(uuid);
        if (at !== undefined) {
          rows[at] = entry;
        } else {
          if (uuid !== undefined) positions.set(uuid, rows.length);
          rows.push(entry);
        }
      }
    });
    return rows;
  }

  /**
   * Lists the sessions of a project that have a main transcript.
   *
   * @param projectKey - The project scope.
   * @returns Each session id with the time of its latest write, from the
   * version metadata, in Unix epoch milliseconds.
   */
  async listSessions(
    projectKey: string,
  ): Promise<Array<{ sessionId: string; mtime: number }>> {
    const prefix = `${PREFIX}${projectPart(projectKey)}.`;
    const suffix = `.${MAIN}.jsonl`;
    const names = (await this.#service.listArtifactKeys()).filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(suffix) &&
        !name.slice(prefix.length, -suffix.length).includes("."),
    );
    const sessions: Array<{ sessionId: string; mtime: number }> = [];
    for (const name of names) {
      let sessionId: string | undefined;
      let mtime = 0;
      for (const item of await this.#service.listArtifactVersions(name)) {
        const meta = item.customMetadata;
        if (meta?.format !== FORMAT || typeof meta.sessionId !== "string") {
          continue;
        }
        sessionId = meta.sessionId;
        mtime = Math.max(mtime, metadataNumber(meta.mtime));
      }
      if (sessionId !== undefined) sessions.push({ sessionId, mtime });
    }
    return sessions;
  }

  /**
   * Lists the subagent transcripts of a session.
   *
   * @param key - The session.
   * @returns The `subpath` of each subagent transcript.
   */
  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const checked = checkKey(key);
    const prefix = `${PREFIX}${projectPart(checked.projectKey)}.${sessionPart(checked.sessionId)}.s`;
    const suffix = ".jsonl";
    return (await this.#service.listArtifactKeys())
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          name.endsWith(suffix) &&
          !name.slice(prefix.length, -suffix.length).includes("."),
      )
      .map((name) =>
        Buffer.from(
          name.slice(prefix.length, -suffix.length),
          "base64url",
        ).toString("utf8"),
      );
  }

  /**
   * Deletes a transcript. Deleting a main transcript also deletes the
   * session's subagent transcripts.
   *
   * @param key - The transcript.
   * @throws {@link AdkArtifactSessionStoreError} with code
   * `SESSION_STORE_INVALID_KEY`.
   */
  async delete(key: SessionKey): Promise<void> {
    const checked = checkKey(key);
    const filename = filenameOf(checked);
    await this.#serial(filename, async () => {
      const existing = new Set(await this.#service.listArtifactKeys());
      const targets = [filename];
      if (checked.subpath === undefined) {
        const subPrefix = `${PREFIX}${projectPart(checked.projectKey)}.${sessionPart(checked.sessionId)}.s`;
        for (const name of existing) {
          if (name.startsWith(subPrefix) && name.endsWith(".jsonl")) {
            targets.push(name);
          }
        }
      }
      for (const name of targets) {
        if (existing.has(name)) await this.#service.deleteArtifact(name);
      }
    });
  }
}

function bindToSession(
  service: BaseArtifactService,
  scope: { appName: string; userId: string; sessionId: string },
): SessionArtifactService {
  return {
    saveArtifact: (request) => service.saveArtifact({ ...scope, ...request }),
    loadArtifact: (request) => service.loadArtifact({ ...scope, ...request }),
    listArtifactKeys: () => service.listArtifactKeys(scope),
    deleteArtifact: (filename) =>
      service.deleteArtifact({ ...scope, filename }),
    listVersions: (filename) => service.listVersions({ ...scope, filename }),
    listArtifactVersions: (filename) =>
      service.listArtifactVersions({ ...scope, filename }),
    getArtifactVersion: (request) =>
      service.getArtifactVersion({ ...scope, ...request }),
  };
}

/**
 * Creates a session store factory that keeps Claude transcripts in the
 * artifact service of the ADK session.
 *
 * @remarks
 * The driver calls the factory once per run with the invocation context. The
 * store uses `options.artifactService` when given (scoped by
 * `context.session`), else `context.artifactService`. Use the `'batched'`
 * flush mode: each `append` is one `saveArtifact`, and some services list all
 * versions on each save.
 *
 * @param options - Artifact service override and version size limit.
 * @returns The factory.
 * @throws {@link AdkArtifactSessionStoreError} with code
 * `SESSION_STORE_INVALID_OPTION` for a bad `maxVersionBytes`. The factory
 * itself throws `SESSION_STORE_NO_ARTIFACT_SERVICE` when no service is
 * available.
 *
 * @experimental
 */
export function adkArtifactSessionStore(
  options: AdkArtifactSessionStoreOptions = {},
): SessionStoreFactory {
  const maxVersionBytes = checkMaxVersionBytes(options.maxVersionBytes);
  return ({ context }) => {
    let service: SessionArtifactService | undefined;
    if (options.artifactService !== undefined) {
      service = bindToSession(options.artifactService, {
        appName: context.session.appName,
        userId: context.session.userId,
        sessionId: context.session.id,
      });
    } else {
      service = context.artifactService;
    }
    if (service === undefined) {
      throw new AdkArtifactSessionStoreError(
        "SESSION_STORE_NO_ARTIFACT_SERVICE",
        "adkArtifactSessionStore needs an artifact service: pass one to the Runner or to adkArtifactSessionStore({ artifactService })",
      );
    }
    return new AdkArtifactSessionStore({
      artifactService: service,
      maxVersionBytes,
    });
  };
}
