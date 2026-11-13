/**
 * Returns only the scheme of a URI (e.g. `data`, `gs`), for safe logging.
 * Never include the rest: `data:` URIs carry whole payloads and `gs://`
 * URIs expose bucket paths.
 */
export function uriScheme(uri: string): string {
  const index = uri.indexOf(":");
  return index > 0 ? uri.slice(0, index) : "unknown";
}
