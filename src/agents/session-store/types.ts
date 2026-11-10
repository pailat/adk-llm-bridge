/**
 * The Claude Agent SDK session store contract, as types the package owns.
 *
 * @remarks
 * These mirror `SessionKey`, `SessionStoreEntry` and `SessionStore` of
 * `@anthropic-ai/claude-agent-sdk` (marked `@alpha` there). They are declared
 * here, not re-exported, so the published declarations never import the
 * optional SDK package: a project that uses only the CLI drivers type-checks
 * without it. A test keeps them assignable both ways to the SDK's types.
 */

/**
 * Identifies one session transcript in a {@link SessionStore}.
 *
 * @experimental Follows the Claude Agent SDK's `@alpha` `SessionKey`.
 */
export type SessionKey = {
  /**
   * Scope of the session. The SDK derives it from the run's working
   * directory, so a resume finds the transcript only from the same path.
   */
  projectKey: string;
  /** The Claude session id. */
  sessionId: string;
  /**
   * Set for a subagent transcript (for example `subagents/agent-<id>`);
   * absent for the main transcript. Never the empty string.
   */
  subpath?: string;
};

/**
 * One line of a Claude session transcript, as the store receives it.
 *
 * @remarks
 * Treat it as an opaque JSON object: `load` must return entries deep-equal
 * to the appended ones. Most entries carry a `uuid`, which is an idempotency
 * key: appending an entry with a `uuid` the key already holds must not add a
 * second row.
 *
 * @experimental Follows the Claude Agent SDK's `@alpha` `SessionStoreEntry`.
 */
export type SessionStoreEntry = {
  /** Kind of transcript line. */
  type: string;
  /** Stable id of the line, when it has one. */
  uuid?: string;
  /** ISO time of the line, when it has one. */
  timestamp?: string;
  [key: string]: unknown;
};

/**
 * Durable storage that the Claude Agent SDK mirrors session transcripts to,
 * and loads them from on resume.
 *
 * @remarks
 * The SDK still writes the local transcript under the Claude config
 * directory; the store gets a second copy. `append` is called after each
 * local write, in batches; a rejected batch is tried 3 times in total (a
 * timeout is not retried), then dropped
 * and reported as a `CLAUDE_SESSION_STORE_MIRROR_ERROR` event. `load` runs
 * once before a resumed run starts.
 *
 * @experimental Follows the Claude Agent SDK's `@alpha` `SessionStore`, which
 * can change in a minor SDK release.
 */
export interface SessionStore {
  /**
   * Stores a batch of transcript entries after the existing ones of `key`,
   * in order. An entry whose `uuid` the key already holds replaces it in
   * place instead of adding a row.
   *
   * @param key - The transcript.
   * @param entries - The new entries.
   */
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  /**
   * Reads a whole transcript.
   *
   * @param key - The transcript.
   * @returns Its entries in append order, or `null` when nothing was stored.
   */
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  /**
   * Lists the sessions of a project with their last modification time.
   *
   * @param projectKey - The project scope.
   * @returns One item per main transcript; `mtime` is Unix epoch
   * milliseconds.
   */
  listSessions?(
    projectKey: string,
  ): Promise<Array<{ sessionId: string; mtime: number }>>;
  /**
   * Deletes a transcript. Deleting a main transcript (no `subpath`) also
   * deletes its subagent transcripts.
   *
   * @param key - The transcript.
   */
  delete?(key: SessionKey): Promise<void>;
  /**
   * Lists the subagent transcripts of a session, so a resume restores them
   * too.
   *
   * @param key - The session.
   * @returns The `subpath` of each subagent transcript.
   */
  listSubkeys?(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]>;
}
