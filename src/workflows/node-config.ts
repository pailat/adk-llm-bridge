import {
  type BaseAgent,
  type BaseAgentConfig,
  InvocationContext,
  type NodeContext,
} from "@google/adk";
import type { WorkflowStepMismatchHint } from "./checkpoint/input-diff.js";
import {
  parseWorkflowReplayAcceptances,
  type WorkflowReplayAcceptance,
} from "./checkpoint/replay-acceptance.js";
import { WorkflowError } from "./contracts.js";

export type { WorkflowStepMismatchHint } from "./checkpoint/input-diff.js";

/**
 * How a re-entered execution treats changes on the steps it replays.
 *
 * @remarks
 * The model is not part of a step's identity: a completed step's result is
 * history, produced by the model the checkpoint recorded, and replaying it
 * does not claim the new model produced it. `agentRevision` stays the
 * explicit, host-chosen "a different build must not replay" signal.
 *
 * The options are host configuration. They are read once when the workflow
 * agent is built and frozen; workflow code (a trusted handler or a sandboxed
 * script) has no way to read or change them.
 */
export interface WorkflowReplayOptions {
  /**
   * What happens when a replayed or resumed step's agent now requests a
   * different model than the one recorded when the step ran.
   *
   * - `warn`: replay the saved result, emit `step_model_changed` and log
   *   `WORKFLOW_STEP_MODEL_CHANGED`. A saved step with no model record (written
   *   before the field existed) cannot be compared: it gets no event, and the
   *   turn logs one `WORKFLOW_STEP_MODEL_UNRECORDED` with the count.
   * - `mismatch`: throw `WORKFLOW_STEP_MISMATCH` with `mismatch: ["model"]`.
   *   It is also thrown when either model is unknown, so pair it with
   *   `requireExplicitModel` and full model ids (an alias can hide a remap).
   *   An execution started before this field existed fails on every reused
   *   step: resume it in `warn` mode.
   *
   * Only a step whose saved outcome is reused is checked. A step that runs
   * again (a retried failure) uses the current model and is never compared.
   * Only the step's own agent is compared; models of nested agents are
   * recorded in `result.models` but a change in them is not reported.
   *
   * @defaultValue `"warn"`
   */
  modelChange?: "warn" | "mismatch";
  /**
   * Store a chunked fingerprint of each step input (`inputLength`, and
   * `inputDigest` for an input longer than 256 UTF-16 code units) so an input
   * mismatch can name the first differing window. With `false` nothing is
   * stored and the hint says `{ available: false, reason: "disabled" }`.
   *
   * @remarks
   * The fingerprint is an unsalted 48-bit digest per chunk, at known offsets.
   * A reader of the checkpoint can confirm guesses for a low-entropy value
   * inside an otherwise predictable chunk, one chunk at a time. Keep secrets
   * out of step inputs; turn the option off when that is not enough.
   * `inputLength` is stored for every step while the option is on, including
   * single-chunk inputs.
   *
   * @defaultValue `true`
   */
  inputDigest?: boolean;
  /**
   * Host-only receiver of the input hint of a `WORKFLOW_STEP_MISMATCH`: input
   * lengths, the first differing window and a structural path, never input
   * text.
   *
   * @remarks
   * Called once, and awaited, before the mismatch error is thrown, so the host
   * has the hint before it sees the error. A callback that never settles holds
   * the turn, as any host hook does. An error or rejection from it is logged
   * and ignored; the mismatch is thrown regardless. Without a callback the
   * hint is logged as `WORKFLOW_STEP_MISMATCH_HINT` (lengths, window and path
   * only): if your logs land where agents can read them, set this callback or
   * `inputDigest: false`. The hint is never put in error details, events or
   * the checkpoint. The window refers to
   * `workflowStepInputCanonicalForm(input)`.
   */
  onStepMismatch?: (hint: WorkflowStepMismatchHint) => void | Promise<void>;
  /**
   * Host-approved changes for completed steps. Each entry keeps one step's
   * saved result although its input or model changed, and is recorded in the
   * checkpoint.
   *
   * @remarks
   * An entry names the execution, the step, the kind (`input` or `model`),
   * the exact saved value (`from`), the exact current value (`to`) and a
   * reason; there are no wildcards, prefixes or "accept all". Entries for this
   * execution are checked against the loaded checkpoint before any step runs:
   * a step that does not exist or is not `completed`, a `from` that is not the
   * saved value, or a `model` entry for a step without a recorded model fails
   * the turn with `WORKFLOW_REPLAY_ACCEPTANCE_INVALID`, which is never saved:
   * the execution stays resumable with a corrected entry. Entries for other
   * executions are ignored (their count is logged at debug level).
   *
   * When the step is reached and its current value equals `to`, the change is
   * applied and audited in one checkpoint save, then the step replays
   * (`step_change_accepted`, warn log `WORKFLOW_REPLAY_CHANGE_ACCEPTED`).
   * After an accepted input change, the step's `inputHash` is the accepted
   * input's hash; the audit entry keeps the old one. An accepted model change
   * leaves `model.requested` as the step ran; the entry's `to` becomes the
   * model every later comparison uses. A relaunch with the same entry is a
   * no-op. A `to` that does not match is the ordinary `WORKFLOW_STEP_MISMATCH`
   * (details list the kind in `acceptanceToDoesNotMatch`). Agent name, agent
   * revision, step status, workflow input, version and source are never
   * acceptable. An entry this turn did not apply is logged once as
   * `WORKFLOW_REPLAY_ACCEPTANCE_UNUSED`.
   *
   * Security: an acceptance replays an old result for a new input. Load
   * acceptances only from a host-only source, never from a file inside any
   * agent's `workingDirectory`, `allowedPaths` or `readPaths`, or a lane
   * worktree: an agent that can write the file can make a gate replay its old
   * verdict for changed code. `approvedBy` is a label, not authentication.
   * Validate an operator file with `parseWorkflowReplayAcceptances`.
   */
  acceptChanges?: readonly WorkflowReplayAcceptance[];
}

/**
 * ADK workflow-node settings accepted by workflow agents.
 *
 * They only take effect when the agent runs as a node of an ADK `Workflow`
 * (or through `ctx.runNode`); as the Runner's root agent they are ignored.
 * A node `timeout` (seconds) cancels the run by closing the event stream, which
 * aborts the underlying workflow runtime. A node `retryConfig` re-enters the
 * same execution (same invocation id): completed steps replay and steps whose
 * last attempt failed run again (see `retryFailedSteps`). `rerunOnResume`
 * defaults to `true` here (ADK's default is `false`) because a step waiting for
 * input is resumed by re-entering the workflow. `waitForOutput` (ADK's join
 * semantics: wait until every predecessor that could trigger the node has
 * finished) is forwarded as is.
 *
 * The agent fields of ADK's `BaseAgentConfig` are accepted too and behave as
 * in any ADK agent: `beforeAgentCallback` and `afterAgentCallback` run around
 * the whole workflow (a before callback that returns content skips it), and
 * `parentAgent` is the agent's parent (normally set by the parent agent that
 * lists it in `subAgents`).
 */
export type WorkflowNodeConfig = Pick<
  BaseAgentConfig,
  | "timeout"
  | "retryConfig"
  | "rerunOnResume"
  | "waitForOutput"
  | "inputSchema"
  | "outputSchema"
  | "stateSchema"
  | "isolationScope"
  | "beforeAgentCallback"
  | "afterAgentCallback"
  | "parentAgent"
> & {
  /**
   * Re-execute steps whose last attempt failed or was interrupted when the
   * execution is entered again.
   *
   * @remarks
   * A step that threw is otherwise replayed as its recorded failure (it runs
   * again only with `resumePolicy: "retry"`). A step stopped by an abort or a
   * timeout (closed run, node `timeout`, run timeout) is recorded
   * `interrupted`, not failed: with this option, or when the step declares
   * `resumePolicy: "retry"`, it runs again as the next attempt. Otherwise,
   * and on a turn that answers a waiting step, the resume fails with
   * `WORKFLOW_INDETERMINATE_STEP`. A step left `running` by a crash stays
   * indeterminate unless it declares `resumePolicy: "retry"`.
   *
   * @defaultValue `true` when `retryConfig` is set, otherwise `false`.
   */
  retryFailedSteps?: boolean;
  /** How a re-entered execution treats model and input changes on replayed steps. */
  replay?: WorkflowReplayOptions;
};

/**
 * Builds the config a workflow agent passes to the `BaseAgent` constructor.
 *
 * @remarks
 * The whole config is forwarded, not only the fields ADK reads: `BaseAgent`
 * stores it, and `clone()` rebuilds the agent by calling the concrete
 * constructor with that stored config, so the definition and every adapter
 * must be in it.
 *
 * @param config - The workflow agent's config.
 * @param defaults - The `description` to use when the config has none.
 * @returns The config for `super()`.
 * @internal
 */
export function workflowAgentBaseConfig<
  T extends WorkflowNodeConfig & {
    name: string;
    description?: string;
    subAgents?: BaseAgent[];
  },
>(config: T, defaults: { description?: string }): T {
  return {
    ...config,
    description: config.description ?? defaults.description,
    subAgents: config.subAgents ?? [],
    // The agent resumes its own waiting steps, so ADK must re-enter it on
    // resume instead of treating the reply as the node's output.
    rerunOnResume: config.rerunOnResume ?? true,
  };
}

/**
 * Whether re-entering an execution re-runs steps whose last attempt failed.
 *
 * @internal
 */
export function resolveRetryFailedSteps(
  config: Pick<WorkflowNodeConfig, "retryConfig" | "retryFailedSteps">,
): boolean {
  return config.retryFailedSteps ?? config.retryConfig !== undefined;
}

/**
 * `WorkflowReplayOptions` with every default applied.
 *
 * @internal
 */
export interface ResolvedWorkflowReplayOptions {
  readonly modelChange: "warn" | "mismatch";
  readonly inputDigest: boolean;
  readonly onStepMismatch?: (
    hint: WorkflowStepMismatchHint,
  ) => void | Promise<void>;
  readonly acceptChanges: readonly WorkflowReplayAcceptance[];
}

const REPLAY_KEYS: ReadonlySet<string> = new Set([
  "modelChange",
  "inputDigest",
  "onStepMismatch",
  "acceptChanges",
]);

/**
 * Validates `config.replay`, applies defaults and freezes the result.
 *
 * @remarks
 * Data fields are copied (acceptances as frozen copies), so a caller that
 * keeps the object and changes it later has no effect. The callback is copied by reference: a function cannot
 * be cloned.
 *
 * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` for a
 * value that is not a plain object, an unknown key, a `modelChange` other
 * than `warn` or `mismatch`, a non-boolean `inputDigest`, a non-function
 * `onStepMismatch`, or an `acceptChanges` list that
 * `parseWorkflowReplayAcceptances` refuses.
 * @internal
 */
export function resolveReplayOptions(
  config: Pick<WorkflowNodeConfig, "replay">,
): ResolvedWorkflowReplayOptions {
  const replay: unknown = config.replay;
  if (replay === undefined) {
    return Object.freeze({
      modelChange: "warn",
      inputDigest: true,
      acceptChanges: Object.freeze([]),
    });
  }
  if (!isPlainObject(replay)) {
    throw invalidReplay("replay must be an object");
  }
  for (const key of Object.keys(replay)) {
    if (!REPLAY_KEYS.has(key))
      throw invalidReplay(`unknown replay key: ${key}`);
  }
  const { modelChange, inputDigest, onStepMismatch, acceptChanges } = replay;
  if (
    modelChange !== undefined &&
    modelChange !== "warn" &&
    modelChange !== "mismatch"
  ) {
    throw invalidReplay('replay.modelChange must be "warn" or "mismatch"');
  }
  if (inputDigest !== undefined && typeof inputDigest !== "boolean") {
    throw invalidReplay("replay.inputDigest must be a boolean");
  }
  if (onStepMismatch !== undefined && typeof onStepMismatch !== "function") {
    throw invalidReplay("replay.onStepMismatch must be a function");
  }
  const accepted =
    acceptChanges === undefined
      ? Object.freeze([])
      : parseWorkflowReplayAcceptances(acceptChanges);
  return Object.freeze({
    modelChange: modelChange ?? "warn",
    inputDigest: inputDigest ?? true,
    acceptChanges: accepted,
    ...(onStepMismatch === undefined
      ? {}
      : {
          onStepMismatch: onStepMismatch as NonNullable<
            ResolvedWorkflowReplayOptions["onStepMismatch"]
          >,
        }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidReplay(message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message);
}

/**
 * Invocation context to run a workflow agent with when ADK drives it as a node.
 *
 * ADK enforces a node `timeout` (and aborts siblings) through
 * `NodeContext.abortSignal`, which is not part of the agent's invocation
 * context. Without merging it in, the workflow runtime keeps running after the
 * node timed out, and an ADK retry would overlap with it.
 *
 * @internal
 */
export function invocationContextForNode(ctx: NodeContext): InvocationContext {
  const base = ctx.getInvocationContext();
  const nodeSignal = ctx.abortSignal;
  if (!nodeSignal || nodeSignal === base.abortSignal) return base;
  return new InvocationContext({
    ...base,
    abortSignal: base.abortSignal
      ? AbortSignal.any([base.abortSignal, nodeSignal])
      : nodeSignal,
  });
}
