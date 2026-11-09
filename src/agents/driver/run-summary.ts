import type {
  ExternalAgentCompletedEvent,
  ExternalAgentUsage,
} from "../events.js";
import { asRecord, stringValue } from "./shared.js";

/** Run facts a driver attaches to its `completed` event. */
export type ExternalAgentRunSummary = Pick<
  ExternalAgentCompletedEvent,
  "model" | "usage" | "numTurns" | "durationMs"
>;

type UsageCounts = Omit<ExternalAgentUsage, "byModel">;

/**
 * Reads the run facts of a Claude `result` message (Agent SDK or
 * `claude -p --output-format stream-json`): `modelUsage` (per model, camelCase),
 * `usage` (snake_case), `total_cost_usd`, `num_turns` and `duration_ms`.
 *
 * `modelUsage` covers every model call of the run, so it wins over `usage`
 * when present. Unknown values are left out, never sent as zeros.
 */
export function claudeResultSummary(message: unknown): ExternalAgentRunSummary {
  const record = asRecord(message);
  const byModel = claudeModelUsage(record.modelUsage);
  const models = Object.keys(byModel);
  let usage: ExternalAgentUsage | undefined;
  if (models.length > 0) {
    usage = sumUsage(Object.values(byModel));
    if (models.length > 1) {
      usage.byModel = byModel;
    }
  } else {
    usage = claudeSnakeUsage(record.usage);
  }
  const totalCostUsd = nonNegativeNumber(record.total_cost_usd);
  if (totalCostUsd !== undefined) {
    usage = { ...(usage ?? {}), totalCostUsd };
  }
  return compact({
    model: models.length === 1 ? models[0] : undefined,
    usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
    numTurns: nonNegativeNumber(record.num_turns),
    durationMs: nonNegativeNumber(record.duration_ms),
  });
}

/**
 * Reads Codex `turn.completed.usage` (`input_tokens`, `cached_input_tokens`,
 * `output_tokens`), from the SDK event or the `codex exec --json` line.
 *
 * Codex `input_tokens` includes the cached tokens; `inputTokens` follows the
 * Anthropic meaning (cache excluded), so the cached count is subtracted.
 */
export function codexTurnUsage(value: unknown): ExternalAgentUsage | undefined {
  const usage = asRecord(value);
  const input = nonNegativeNumber(usage.input_tokens);
  const cached = nonNegativeNumber(usage.cached_input_tokens);
  const result = compact({
    inputTokens:
      input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
    outputTokens: nonNegativeNumber(usage.output_tokens),
    cacheReadInputTokens: nonNegativeNumber(usage.cached_input_tokens),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

/** The `model` of a Claude `system`/`init` message, if this is one. */
export function claudeInitModel(message: unknown): string | undefined {
  const record = asRecord(message);
  return record.type === "system" && record.subtype === "init"
    ? stringValue(record.model)
    : undefined;
}

function claudeModelUsage(value: unknown): Record<string, UsageCounts> {
  const result: Record<string, UsageCounts> = {};
  for (const [model, raw] of Object.entries(asRecord(value))) {
    const entry = asRecord(raw);
    const counts = compact({
      inputTokens: nonNegativeNumber(entry.inputTokens),
      outputTokens: nonNegativeNumber(entry.outputTokens),
      cacheReadInputTokens: nonNegativeNumber(entry.cacheReadInputTokens),
      cacheCreationInputTokens: nonNegativeNumber(
        entry.cacheCreationInputTokens,
      ),
      totalCostUsd: nonNegativeNumber(entry.costUSD),
    });
    if (model.length > 0 && Object.keys(counts).length > 0) {
      result[model] = counts;
    }
  }
  return result;
}

function claudeSnakeUsage(value: unknown): ExternalAgentUsage | undefined {
  const usage = asRecord(value);
  const result = compact({
    inputTokens: nonNegativeNumber(usage.input_tokens),
    outputTokens: nonNegativeNumber(usage.output_tokens),
    cacheReadInputTokens: nonNegativeNumber(usage.cache_read_input_tokens),
    cacheCreationInputTokens: nonNegativeNumber(
      usage.cache_creation_input_tokens,
    ),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Sums each counter over the entries that report it. */
function sumUsage(entries: readonly UsageCounts[]): ExternalAgentUsage {
  const keys = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "totalCostUsd",
  ] as const;
  const result: ExternalAgentUsage = {};
  for (const key of keys) {
    const values = entries
      .map((entry) => entry[key])
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) {
      result[key] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  return result;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
