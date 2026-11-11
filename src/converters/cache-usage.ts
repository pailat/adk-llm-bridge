/**
 * Cache-write token plumbing shared by the provider converters.
 *
 * genai's usage metadata has a cache-read field (`cachedContentTokenCount`)
 * but no cache-write field, so the write count rides on
 * `LlmResponse.customMetadata`, the ADK free-form channel that also carries
 * `logprobs`.
 */

/** `customMetadata` key holding the tokens a call wrote to the prompt cache. */
export const CACHE_CREATION_METADATA_KEY = "cacheCreationTokenCount";

/**
 * Returns `customMetadata` with the cache-write count added, keeping every key
 * already there. Returns `customMetadata` unchanged when no count is known.
 */
export function withCacheCreation(
  customMetadata: Record<string, unknown> | undefined,
  tokens: number | undefined,
): Record<string, unknown> | undefined {
  if (tokens === undefined) return customMetadata;
  return { ...customMetadata, [CACHE_CREATION_METADATA_KEY]: tokens };
}
