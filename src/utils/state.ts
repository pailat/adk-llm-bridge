/**
 * ADK session state helpers.
 *
 * ADK `temp:` keys are scratch values for the current invocation. Whatever the
 * installed ADK does with them during an invocation, the bridge never carries
 * them into a result `stateDelta` or a checkpoint.
 */

import { State } from "@google/adk";

/**
 * Whether `key` is an ADK `temp:` state key.
 *
 * @param key - State key.
 * @returns True for a key that starts with `temp:`.
 */
export function isTempStateKey(key: string): boolean {
  return key.startsWith(State.TEMP_PREFIX);
}

/**
 * Copy of a state delta without its `temp:` keys.
 *
 * @param delta - State delta to filter; it is not mutated.
 * @returns A new plain object with every other key.
 */
export function withoutTempStateKeys(
  delta: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(delta).filter(([key]) => !isTempStateKey(key)),
  );
}
