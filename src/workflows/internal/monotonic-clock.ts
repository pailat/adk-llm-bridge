/**
 * Clock for elapsed time inside one process. Not exported from any public
 * barrel.
 *
 * @remarks
 * Waits and budgets that live and end in one process (lock acquisition
 * timeouts, grace periods, the sandbox CPU budget) read this clock instead of
 * `Date.now()`. A wall-clock step, such as an NTP correction, a manual change,
 * or the jump a host sees when it wakes from sleep, then neither ends them
 * early nor stretches them. The value has an arbitrary origin: compare it only
 * with other readings of the same process, and never persist it. Durable
 * expiry shared between processes, such as workspace and task leases, stays
 * in epoch milliseconds.
 */

/**
 * Reads the monotonic clock.
 *
 * @returns Milliseconds since an arbitrary origin fixed for the process.
 * @internal
 */
export function monotonicNow(): number {
  return performance.now();
}
