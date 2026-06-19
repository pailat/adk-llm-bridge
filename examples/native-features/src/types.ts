/**
 * Shared contracts for the native-features showcase.
 *
 * These types give the demos, the harness, and the CLI a single vocabulary.
 * Kept dependency-light: only structural types, no ADK runtime imports.
 */
import type { AgentHarness } from "./runner";
import type { Output } from "./output";

/** Which library factory builds the model. */
export type ProviderName =
  | "anthropic"
  | "openai"
  | "ai-gateway"
  | "openrouter"
  | "xai";

/** Resolved, validated application configuration. */
export interface AppConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  /** True when `model` came from an explicit --model / MODEL (not the default). */
  modelExplicit: boolean;
}

/**
 * Strategy interface — every native feature is one self-contained Demo.
 * Demos receive everything they need via {@link DemoContext} (dependency
 * injection); they never import globals.
 */
export interface Demo {
  /** Stable CLI name, e.g. "reasoning". */
  name: string;
  /** One-line description shown in `list` and the per-demo header. */
  description: string;
  /** Execute the demo. */
  run(ctx: DemoContext): Promise<void>;
}

/** Injected into every {@link Demo.run}. */
export interface DemoContext {
  harness: AgentHarness;
  out: Output;
  config: AppConfig;
}

/** Token-usage snapshot read from the final, non-partial event. */
export interface Usage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

/**
 * Typed reduction of an ADK Event stream produced by {@link AgentHarness}.
 * Demos read this instead of touching raw events.
 */
export interface RunResult {
  /** Concatenated final (non-thought, non-partial) answer text. */
  finalText: string;
  /** Concatenated reasoning / extended-thinking text (part.thought === true). */
  thoughtText: string;
  /** Function calls the model emitted (forced or otherwise). */
  toolCalls: Array<{ name: string; args: unknown }>;
  /**
   * Parsed structured-output object, when `LlmAgent.outputSchema` is set.
   *
   * Depending on the provider/path, ADK 1.2 surfaces an `outputSchema` result
   * either as JSON text (which ADK auto-parses into `session.state[outputKey]`)
   * or as a forced `json_output` function call carrying the object as its args.
   * The harness normalizes both into this field.
   */
  structured?: unknown;
  /** How many partial (streaming) events arrived. */
  partials: number;
  /** Usage metadata from the final non-partial event, if present. */
  usage?: Usage;
  /**
   * True when the run hit its `maxLlmCalls` bound. Used by the forced-tool
   * demo, where `mode: ANY` would otherwise loop forever: capping LLM calls is
   * how we stop after the single forced call. Not an error condition there.
   */
  stoppedByLlmCallLimit?: boolean;
}
