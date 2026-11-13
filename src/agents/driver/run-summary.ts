import type {
  ExternalAgentCompletedEvent,
  ExternalAgentModelUsage,
  ExternalAgentUsage,
} from "../events.js";
import { asRecord, stringValue } from "./shared.js";

/** Run facts a driver attaches to its `completed` event. */
export type ExternalAgentRunSummary = Pick<
  ExternalAgentCompletedEvent,
  "model" | "usage" | "numTurns" | "durationMs"
>;

type UsageCounts = ExternalAgentModelUsage;

/**
 * Reads the run facts of a Claude `result` message (Agent SDK or
 * `claude -p --output-format stream-json`): `modelUsage` (per model, camelCase),
 * `usage` (snake_case), `total_cost_usd`, `num_turns` and `duration_ms`.
 *
 * `modelUsage` covers every model call, helper models included, so it wins
 * over `usage` (the main model's calls only) when present. Unknown values are
 * left out, never sent as zeros.
 *
 * A resumed Claude session reports `modelUsage` and `total_cost_usd` for the
 * whole session so far. Pass the previous `result` message of the same session
 * as `previous` to get this run's share: the `modelUsage` token counters, each
 * model's `costUSD` and `total_cost_usd` become `current - previous`, and the
 * usage gets `scope: "run"`. `usage`, `num_turns` and `duration_ms` are left
 * as reported. When that is not possible the session
 * total is reported with `scope: "session"`: `previous` lacks a counter the
 * current message has, a counter went down, or there is no `previous` and the
 * run resumed (or forked) an existing session. A fresh run with no `previous`
 * reports its own counters as `scope: "run"`.
 *
 * @param message - The `result` message.
 * @param previous - The previous `result` message of the same SDK session.
 * @param resumed - Whether this run resumed or forked an existing session.
 * @returns The model, usage, turns and duration of the run. `usage.scope` is
 * `"session"` when the usage is the session total.
 * @internal
 */
export function claudeResultSummary(
  message: unknown,
  previous?: unknown,
  resumed = false,
): ExternalAgentRunSummary {
  const current = asRecord(message);
  const delta = previous
    ? claudeResultDelta(current, asRecord(previous))
    : undefined;
  const record = delta ?? current;
  const scope = delta || (!previous && !resumed) ? "run" : "session";
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
    usage:
      usage && Object.keys(usage).length > 0 ? { ...usage, scope } : undefined,
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
 *
 * @internal
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

const MODEL_COUNTER_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "costUSD",
] as const;

/**
 * Keeps only the cumulative counters of a Claude `result` message:
 * `total_cost_usd` and, per model, the token counters and `costUSD`.
 *
 * @remarks
 * This is the part {@link claudeResultSummary} needs as `previous`. The result
 * text and everything else are dropped, so it is cheap to hold for a long
 * time.
 *
 * @param message - The `result` message.
 * @returns `total_cost_usd` and `modelUsage` with the counters only.
 * @internal
 */
export function claudeResultBaseline(
  message: unknown,
): Record<string, unknown> {
  const record = asRecord(message);
  const modelUsage: Record<string, unknown> = {};
  for (const [model, raw] of Object.entries(asRecord(record.modelUsage))) {
    const entry = asRecord(raw);
    modelUsage[model] = Object.fromEntries(
      MODEL_COUNTER_KEYS.filter((key) => typeof entry[key] === "number").map(
        (key) => [key, entry[key]],
      ),
    );
  }
  return { total_cost_usd: record.total_cost_usd, modelUsage };
}

/**
 * Copy of `record` with the session-cumulative counters reduced to this run,
 * or `undefined` when `previous` is not a complete baseline for it: a counter
 * of `record` is missing in `previous` or went down, or a model of `previous`
 * is missing in `record` (session totals never lose a model). A model absent
 * from `previous` had no usage before, so its counters count from zero.
 */
function claudeResultDelta(
  record: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const before = asRecord(previous.modelUsage);
  const now = asRecord(record.modelUsage);
  if (Object.keys(before).some((model) => !(model in now))) return undefined;
  const modelUsage: Record<string, unknown> = {};
  for (const [model, raw] of Object.entries(now)) {
    const base = model in before ? asRecord(before[model]) : undefined;
    const entry: Record<string, unknown> = { ...asRecord(raw) };
    for (const key of MODEL_COUNTER_KEYS) {
      if (typeof entry[key] !== "number") continue;
      const delta = counterDelta(entry[key], base ? base[key] : 0);
      if (delta === undefined) return undefined;
      entry[key] = delta;
    }
    modelUsage[model] = entry;
  }
  let cost = record.total_cost_usd;
  if (typeof cost === "number") {
    cost = counterDelta(cost, previous.total_cost_usd);
    if (cost === undefined) return undefined;
  }
  return {
    ...record,
    ...(record.modelUsage === undefined ? {} : { modelUsage }),
    total_cost_usd: cost,
  };
}

/** `current - base`, or `undefined` when `base` is missing or larger. */
function counterDelta(current: number, base: unknown): number | undefined {
  return typeof base === "number" && current >= base
    ? current - base
    : undefined;
}

/**
 * The `model` of a Claude `system`/`init` message, if this is one.
 *
 * @internal
 */
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
