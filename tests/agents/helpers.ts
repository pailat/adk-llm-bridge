/**
 * Shared test helpers for the external-agent suites.
 */

/**
 * Races `promise` against a deadline. The timer is always cleared once the
 * promise settles, so a passing test never leaves a pending timeout behind.
 * Use a generous `ms` (>= 2000): the deadline only needs to catch a hang, not
 * measure speed, so it must not flake on a loaded CI machine.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls `condition` until it holds or `ms` passes, then returns its last
 * value. Use it for state the test cannot await, such as a process that the
 * OS reaps after it exits.
 */
export async function waitUntil(
  condition: () => boolean,
  ms = 5000,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) return condition();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

/**
 * A Codex MCP lister for a host with no MCP servers. Network is off by
 * default, so a Codex CLI run lists the host servers to turn them off; tests
 * that are not about that listing use this instead of spawning `mcp list`.
 */
export const noHostMcpServers = async (): Promise<readonly string[]> => [];
