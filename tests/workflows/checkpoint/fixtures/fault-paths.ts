/**
 * Path checks of the checkpoint fault fixture, kept free of side effects so a
 * test can check them on Windows-style paths too.
 */

/** `path` with `/` as its only separator. */
function slashes(path: unknown): string {
  return String(path).replaceAll("\\", "/");
}

/** Whether `path` is a lock directory or a path inside one. */
export function isLockPath(path: unknown): boolean {
  const text = slashes(path);
  return text.endsWith(".json.lock") || text.includes(".json.lock/");
}

/** Whether `path` is the owner file of a lock directory. */
export function isLockOwnerPath(path: unknown): boolean {
  return slashes(path).endsWith(".json.lock/owner.json");
}

/** Whether two paths name the same entry, whatever separators they use. */
export function samePath(left: unknown, right: unknown): boolean {
  return slashes(left) === slashes(right);
}
