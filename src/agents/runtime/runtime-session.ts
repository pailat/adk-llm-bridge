/**
 * Session identity that a driver passes to an external runtime.
 *
 * @remarks
 * `id` is the runtime's own session or thread id, used to resume a
 * conversation across turns. It is distinct from the ADK session id.
 */
export interface AgentRuntimeSession {
  /** Runtime session or thread id. */
  id: string;
  /** Id of the session this one was started from, when it was forked. */
  parentId?: string;
  /** Name of the root agent that owns the session. */
  rootAgentName?: string;
  /** Free-form, driver-specific session data. */
  metadata?: Record<string, unknown>;
}
