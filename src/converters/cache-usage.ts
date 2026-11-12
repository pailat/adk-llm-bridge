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
 * `customMetadata` key holding what the call cost in US dollars, as the
 * provider reported it; {@link COST_SOURCE_METADATA_KEY} says which field it
 * came from. AI Gateway and OpenRouter `usage.cost` is the amount debited
 * from the account, which is `0` for a BYOK call (`is_byok`): the key's owner
 * pays the provider directly. For a BYOK call the amount is then:
 * - `cost` plus `cost_details.upstream_inference_cost` when that is reported
 *   and positive (the OpenRouter shape; source `cost+upstream`);
 * - otherwise `usage.market_cost`, the gateway's only figure for the charge
 *   (measured on a live BYOK gateway key; source `market_cost`).
 *
 * A call that is not BYOK keeps `cost` (source `cost`). A BYOK call with no
 * upstream and no market figure keeps `cost` too. Only reported amounts are
 * used; there is no price table.
 */
export const COST_METADATA_KEY = "costUsd";

/**
 * `customMetadata` key naming the usage field {@link COST_METADATA_KEY} came
 * from: `"cost"`, `"cost+upstream"` or `"market_cost"`. Present exactly when
 * `costUsd` is.
 */
export const COST_SOURCE_METADATA_KEY = "costSource";

/** The field a reported cost came from; see {@link COST_SOURCE_METADATA_KEY}. */
export type CostSource = "cost" | "cost+upstream" | "market_cost";

/**
 * `customMetadata` key holding the market (list-price) cost the AI Gateway
 * reports as `usage.market_cost`. Recorded as is; it is also what
 * {@link COST_METADATA_KEY} uses for a BYOK call with no upstream cost.
 */
export const MARKET_COST_METADATA_KEY = "marketCostUsd";

/** A finite, non-negative number, otherwise `undefined`. */
function money(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Costs a provider reported on one usage object. */
export interface ReportedCost {
  costUsd?: number;
  costSource?: CostSource;
  marketCostUsd?: number;
}

/**
 * Reads `cost`, `cost_details.upstream_inference_cost` and `market_cost` from a
 * raw OpenAI-shaped usage object and applies the rule of
 * {@link COST_METADATA_KEY}. Values that are not finite non-negative numbers
 * are ignored.
 */
export function reportedCost(usage: unknown): ReportedCost {
  if (!usage || typeof usage !== "object") return {};
  const raw = usage as {
    cost?: unknown;
    market_cost?: unknown;
    is_byok?: unknown;
    cost_details?: { upstream_inference_cost?: unknown } | null;
  };
  const debited = money(raw.cost);
  const marketCostUsd = money(raw.market_cost);
  const byok = raw.is_byok === true;
  const upstream = byok
    ? money(raw.cost_details?.upstream_inference_cost)
    : undefined;
  let costUsd = debited;
  let costSource: CostSource | undefined =
    debited === undefined ? undefined : "cost";
  if (upstream !== undefined && upstream > 0) {
    costUsd = (debited ?? 0) + upstream;
    costSource = "cost+upstream";
  } else if (byok && marketCostUsd !== undefined) {
    costUsd = marketCostUsd;
    costSource = "market_cost";
  }
  return {
    ...(costUsd !== undefined ? { costUsd, costSource } : {}),
    ...(marketCostUsd !== undefined ? { marketCostUsd } : {}),
  };
}

/** Returns `customMetadata` with the reported costs added; unchanged when none. */
export function withCost(
  customMetadata: Record<string, unknown> | undefined,
  cost: ReportedCost,
): Record<string, unknown> | undefined {
  if (cost.costUsd === undefined && cost.marketCostUsd === undefined) {
    return customMetadata;
  }
  return {
    ...customMetadata,
    ...(cost.costUsd !== undefined
      ? {
          [COST_METADATA_KEY]: cost.costUsd,
          ...(cost.costSource !== undefined
            ? { [COST_SOURCE_METADATA_KEY]: cost.costSource }
            : {}),
        }
      : {}),
    ...(cost.marketCostUsd !== undefined
      ? { [MARKET_COST_METADATA_KEY]: cost.marketCostUsd }
      : {}),
  };
}

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
