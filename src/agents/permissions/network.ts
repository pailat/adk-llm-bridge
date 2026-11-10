/**
 * The network rule every driver and the permission guard share. Not part of
 * the public API: do not re-export from any barrel.
 */

import type { ExternalAgentPermissionPolicy } from "./schema.js";

/**
 * Whether a run may reach the network.
 *
 * @remarks
 * Network is off unless the policy sets `allowNetwork: true`. An unset
 * `allowNetwork`, or no policy at all, counts as `false`, so a driver run
 * directly (without an `ExternalAgent`) gets the same default as one
 * run by an agent.
 *
 * @param policy - The effective permission policy of the run, if any.
 * @returns `true` only for an explicit `allowNetwork: true`.
 * @internal
 */
export function networkAllowed(
  policy: ExternalAgentPermissionPolicy | undefined,
): boolean {
  return policy?.allowNetwork === true;
}
