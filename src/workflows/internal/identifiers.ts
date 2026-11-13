/**
 * Named identifier grammars shared by every workflow store, controller and
 * driver.
 *
 * @remarks
 * Each grammar starts with an ASCII letter or digit, so no identifier is
 * blank, starts with a separator or carries whitespace:
 *
 * - record id: up to 256 characters of `A-Z a-z 0-9 . _ : -`. Executions,
 *   tasks, plans, lanes, agents, grants, proposals, messages, leases and
 *   workers. An agent id is a record id because it is stored on plans, task
 *   records and change sets alike.
 * - principal id: a record id that may also contain `@` and `/`, for the
 *   host principal (`actorId`) of an authenticated actor, such as
 *   `team/reviewer` or `user@example.com`.
 * - opaque id: up to 256 characters of `A-Z a-z 0-9 . _ : + / -`. Receipts,
 *   host operations, artifacts, workspaces and other resource ids, and
 *   workflow definition ids and versions.
 * - revision: an opaque id of up to 512 characters, for base revisions,
 *   workspace revisions and digests.
 *
 * @packageDocumentation
 */

/** Grammar of a workflow identifier; see the module remarks. @internal */
export type WorkflowIdentifierGrammar =
  | "record"
  | "principal"
  | "opaque"
  | "revision";

const GRAMMARS: Readonly<Record<WorkflowIdentifierGrammar, RegExp>> =
  Object.freeze({
    record: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u,
    principal: /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u,
    opaque: /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u,
    revision: /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,511}$/u,
  });

/**
 * Tells whether a value matches a named identifier grammar.
 *
 * @param value - Candidate identifier.
 * @param grammar - Grammar to apply.
 * @returns True when `value` is a string in the grammar.
 * @internal
 */
export function isWorkflowIdentifier(
  value: unknown,
  grammar: WorkflowIdentifierGrammar,
): value is string {
  return typeof value === "string" && GRAMMARS[grammar].test(value);
}
