import {
  type AfterToolCallback,
  AsyncQueue,
  BaseAgent,
  type BaseAgentConfig,
  type BeforeToolCallback,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
  isBaseTool,
  isBaseToolset,
  type SingleAfterToolCallback,
  type SingleBeforeToolCallback,
  type ToolUnion,
} from "@google/adk";
import type { Content } from "@google/genai";
import { withCacheCreation } from "../converters/cache-usage.js";
import { parseJson } from "../utils/json.js";
import { LogCode, warn } from "../utils/log.js";
import type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
import { NoopCredentialProvider } from "./auth/credential-provider.js";
import { snapshotCredential } from "./auth/snapshot.js";
import {
  EXTERNAL_AGENT_APPROVALS_UNSUPPORTED,
  EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED,
  EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN,
  EXTERNAL_AGENT_TOOL_NOT_READ_ONLY,
  EXTERNAL_AGENT_TOOLS_UNSUPPORTED,
  ExternalAgentPolicyError,
  policyErrorEvent,
} from "./driver/policy-errors.js";
import {
  errorTitle,
  isPlainRecord,
  itemTitle,
  stringOrEmpty,
  textTitle,
  toolCallTitle,
  toolResponseTitle,
} from "./event-titles.js";
import {
  EXTERNAL_AGENT_CONFIRMATION_UNUSED,
  EXTERNAL_AGENT_ERROR,
  EXTERNAL_AGENT_MODEL_METADATA_KEY,
  EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED,
  EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE,
  type ExternalAgentCompletedEvent,
  type ExternalAgentEvent,
  type ExternalAgentModelInfo,
  type ExternalAgentStartedEvent,
} from "./events.js";
import type { ExternalAgentDriver } from "./external-agent-driver.js";
import { PlaceholderExternalAgentDriver } from "./external-agent-driver.js";
import {
  createAnswersConsumedEvent,
  createConfirmationRequestEvent,
  describeAnswers,
  type ExternalAgentConfirmationOptions,
  guardPermissionRequest,
  normalizeDecision,
  type PermissionDecision,
  type PermissionRequest,
  permissionSignature,
  readConfirmationAnswers,
  readOnlyWebToolAllowed,
} from "./permissions/confirmation.js";
import {
  deriveSubAgentPermissionPolicy,
  resolveEffectivePermissions,
} from "./permissions/inheritance.js";
import {
  assertPermissionPolicy,
  snapshotPermissionPolicy,
} from "./permissions/policy.js";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import { ExternalAgentRunTracer, usageMetadataFor } from "./telemetry.js";
import {
  ADK_TOOL_PREFIX,
  type AdkToolBridge,
  type AdkToolExecutionResult,
  BRIDGE_TOOL_PREFIX,
  createAdkToolBridge,
  EXTERNAL_AGENT_TOOLS_METADATA_KEY,
  type ExternalAgentToolsReport,
  isBridgedToolName,
  toResponseObject,
} from "./tools/adk-tool-bridge.js";
import {
  createLongRunningCallEvent,
  createResultsConsumedEvent,
  driverContextFor,
  findOversizedResults,
  LONG_RUNNING_RESULTS_NOTE,
  readLongRunningResults,
} from "./tools/long-running.js";
import { type DelegationOptions, ToolGateway } from "./tools/tool-gateway.js";

function normalizeToolCallArgs(input: unknown): Record<string, unknown> {
  if (input === undefined) {
    return {};
  }

  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return { input };
}

/**
 * Brand carried by every `ExternalAgent` instance. `Symbol.for` makes it the
 * same key in every copy of this module (a duplicated install or a bundle
 * split), where `instanceof` would fail and silently skip the ancestor.
 */
const EXTERNAL_AGENT_BRAND = Symbol.for(
  "adk-llm-bridge.agents.external-agent.v1",
);

/** Read by every brand reader; anything else counts as unreadable. */
type PolicyReader = () => ExternalAgentPermissionPolicy | undefined;

/** Policy that a branded ancestor with an unreadable policy counts as. */
const UNREADABLE_POLICY: ExternalAgentPermissionPolicy = Object.freeze({
  mode: "ask",
});

/** Defines the brand on `agent`: a frozen reader of its current policy. */
function brandExternalAgent(agent: ExternalAgent): void {
  const reader: PolicyReader = () => {
    const policy = snapshotPermissionPolicy(agent.permissions);
    return policy === null ? UNREADABLE_POLICY : policy;
  };
  Object.defineProperty(agent, EXTERNAL_AGENT_BRAND, {
    value: Object.freeze(reader),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * The brand reader of `node`, or `undefined` when `node` is not branded. The
 * brand must be an own property: a prototype-inherited key does not count.
 */
function brandOf(node: object): { reader: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(
    node,
    EXTERNAL_AGENT_BRAND,
  );
  return descriptor ? { reader: descriptor.value } : undefined;
}

/**
 * Policy of a branded ancestor, read only through its brand reader and
 * re-validated here. Fails closed: a reader that is missing, not frozen, a
 * getter, throws, or returns a malformed policy counts as `ask`.
 */
function readBrandedPolicy(brand: {
  reader: unknown;
}): ExternalAgentPermissionPolicy | undefined {
  const { reader } = brand;
  if (typeof reader !== "function" || !Object.isFrozen(reader)) {
    return UNREADABLE_POLICY;
  }
  try {
    const policy = snapshotPermissionPolicy((reader as PolicyReader)());
    return policy === null ? UNREADABLE_POLICY : policy;
  } catch {
    return UNREADABLE_POLICY;
  }
}

/**
 * Policy of `agent` capped by every `ExternalAgent` above it in the agent
 * tree, folded root-down with the same rule `ToolGateway` applies on each
 * delegation (`deriveSubAgentPermissionPolicy(parentEffective, childOwn)`,
 * where a parent with no policy counts as `ask`). Other agents in between
 * (LlmAgent, Sequential...) do not delegate through the gateway and are
 * skipped. With no ExternalAgent ancestor this is the agent's own policy.
 *
 * Ancestors are detected by the {@link EXTERNAL_AGENT_BRAND} brand, not
 * `instanceof`, so an ancestor built by another copy of this class still caps
 * the agent. Their policy is read only through the brand reader and is
 * re-validated; an unreadable one counts as `ask`. Only the static tree is
 * covered (see `permissions/inheritance.ts`).
 */
function ancestryPermissions(
  agent: ExternalAgent,
): ExternalAgentPermissionPolicy | undefined {
  const chain: { reader: unknown }[] = [];
  for (let node = agent.parentAgent; node; node = node.parentAgent) {
    const brand = brandOf(node);
    if (brand) chain.unshift(brand);
  }
  const [root, ...rest] = chain;
  if (!root) {
    return agent.permissions;
  }
  let effective = readBrandedPolicy(root);
  for (const brand of rest) {
    effective = deriveSubAgentPermissionPolicy(
      effective,
      readBrandedPolicy(brand),
    );
  }
  return deriveSubAgentPermissionPolicy(effective, agent.permissions);
}

/**
 * Configuration of an {@link ExternalAgent}. Extends ADK's `BaseAgentConfig`, so
 * `beforeAgentCallback` / `afterAgentCallback` and the workflow-node options
 * (`retryConfig`, `timeout`, `inputSchema`, `outputSchema`, `stateSchema`,
 * `isolationScope`, ...) are accepted and honored by ADK when the agent runs as
 * a node. The whole object is forwarded to `super()` so `BaseAgent.clone()` can
 * rebuild the agent (provider, driver, permissions included).
 *
 * With an `outputSchema`, the final answer is parsed as JSON before ADK
 * validates it. Integers beyond `Number.MAX_SAFE_INTEGER` arrive as strings
 * of their exact digits, so declare such fields as `z.string()` (or a union
 * with `z.number()`), not as `z.number()`.
 *
 * `clone()` reuses the same `driver` instance. The Claude SDK driver keeps its
 * resume state per agent instance, so clones sharing it never resume each
 * other's transcript. Codex keeps its thread id in session state keyed by agent
 * name, so clones that run in the same session need distinct names (ADK already
 * requires unique names within an agent tree):
 * `agent.clone({ name: "b" })`. Pass a fresh `driver` in the overrides when a
 * driver holds other per-run state.
 */
export interface ExternalAgentConfig extends BaseAgentConfig {
  /** The external runtime provider. */
  provider: ExternalAgentProviderDefinition;
  /**
   * Runs the runtime. When omitted, a {@link PlaceholderExternalAgentDriver}
   * reports a recoverable error on every turn.
   */
  driver?: ExternalAgentDriver;
  /**
   * Supplies the runtime's credential.
   *
   * @defaultValue A {@link NoopCredentialProvider}: the runtime uses its own login state.
   */
  credentialProvider?: ExternalAgentCredentialProvider;
  /** System instruction passed to the runtime. */
  instruction?: string;
  /** Directory the runtime works in. */
  workingDirectory?: string;
  /**
   * Permission policy of this agent. It is capped by the policy of every
   * `ExternalAgent` above it in the agent tree and never widens it.
   */
  permissions?: ExternalAgentPermissionPolicy;
  /**
   * Delegation behavior when `subAgents` are present. `finalAnswer: "subagent"`
   * (default, ADK-like) makes a sub-agent's terminal answer the answer of the
   * turn; `"coordinator"` lets the coordinator synthesize afterwards.
   *
   * @defaultValue `{ finalAnswer: "subagent" }`
   */
  delegation?: DelegationOptions;
  /**
   * How permission prompts of the runtime (the `ask` mode) are answered. Without
   * it every prompt is denied. A confirmation never widens the effective policy
   * and `read-only` is never confirmable. Supported only by drivers that can
   * intercept prompts (Claude Agent SDK). An `approver` or `adk: true` on any
   * other built-in driver (Claude CLI, Codex, Gemini CLI) throws
   * `EXTERNAL_AGENT_APPROVALS_UNSUPPORTED` at construction, because the
   * runtime decides alone and the setting would be ignored. A custom driver
   * without `capabilities()` is not checked.
   *
   * `allowedPaths` (and `readPaths`, for read tools) is checked on the
   * runtime's blocked path and on the path inputs of file tools, after
   * normalization and symlink resolution (dangling links included). The
   * Claude Agent SDK driver also checks every tool call, not only prompts,
   * and approves reads inside `readPaths` itself; the Claude CLI, Codex and
   * Gemini CLI drivers refuse a run with `allowedPaths` or `readPaths` with
   * `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` unless built with
   * `allowUnenforcedPaths: true`.
   * Unless the policy sets `allowNetwork: true`, web tools (`WebFetch`,
   * `WebSearch` and their Codex and Gemini CLI names) are denied, MCP tools
   * other than this run's registered bridge tools are denied too, and a shell call is approved only when the driver runs it
   * in a no-network sandbox (or the Claude driver was built with
   * `allowUnsandboxedShell: true`). An unset `allowNetwork`, or no policy,
   * counts as `false`. Drivers that cannot keep the network off refuse the
   * run with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` unless built with
   * `allowUnenforcedNetwork: true`: Codex in `full-access`, Codex when its
   * host MCP servers cannot be listed, a Codex driver given a prebuilt `sdk`
   * client (its MCP servers cannot be turned off), and Gemini CLI in every
   * mode. The Claude drivers refuse a run whose configured `tools` name a web
   * tool while the network is off.
   * Under `read-only` with `allowNetwork: true`, web tools run without a
   * confirmation (no approver is asked), so the agent can send what it reads
   * to the network; every other tool stays denied.
   */
  confirmation?: ExternalAgentConfirmationOptions;
  /**
   * ADK tools and toolsets to expose to the external runtime (as in
   * `LlmAgent.tools`). Supported by drivers that can host tools (Claude Agent
   * SDK, through its in-process MCP server); the other built-in drivers refuse
   * them at construction (`EXTERNAL_AGENT_TOOLS_UNSUPPORTED`). A custom driver
   * without `capabilities()` is not checked, because the bridge cannot know
   * whether it reads `request.adkTools`. Tools that require confirmation go
   * through {@link ExternalAgentConfig.confirmation}. Expose sub-agents with
   * `subAgents`, never with `AgentTool` (it breaks permission inheritance).
   *
   * The actions a tool sets on its context follow ADK semantics:
   * - `stateDelta` and `artifactDelta` are published on this agent's
   *   timeline. Artifacts are saved through the invocation's artifact
   *   service by `toolContext.saveArtifact`.
   * - `escalate`, `transferToAgent` and `skipSummarization` ride on the
   *   tool's function response. `escalate` alone does not end the turn: the
   *   runtime goes on, and an enclosing `LoopAgent` stops after this agent's
   *   turn, as in ADK. `skipSummarization` and `transferToAgent` end the
   *   external turn after the call, as ADK's `LlmAgent` stops after such a
   *   response (`ExitLoopTool` sets both `escalate` and
   *   `skipSummarization`). A transfer then runs the target agent in this
   *   invocation, with this agent's policy as its ceiling; the target sees
   *   this agent's events up to the tool's response. A transfer to an unknown
   *   agent, or to this agent, fails the call instead.
   * - The actions are paired with the first successful result the runtime
   *   reports for a tool of that name. Limit: when the runtime runs two calls
   *   of the same tool in parallel and only one sets actions, they can ride
   *   on the other call's result.
   * - `toolContext.requestConfirmation()` inside `execute` goes through
   *   {@link ExternalAgentConfig.confirmation}, like `requireConfirmation`.
   *   The tool then runs again with the decision in
   *   `toolContext.toolConfirmation` (also when rejected), carrying the
   *   `payload` of the human's answer or of an approver's decision (for
   *   example an edited amount) and the answer's `hint`. The response
   *   and state changes of the first, unconfirmed run are dropped. With the
   *   ADK protocol the turn pauses once; when the runtime retries the call
   *   on the next turn, the tool runs once, with the human's decision. When
   *   the human approved and the runtime does not make the call again on
   *   that turn, the approved call never ran: the turn ends with an
   *   `EXTERNAL_AGENT_CONFIRMATION_UNUSED` error event.
   * - A long-running tool (`isLongRunning`, such as `LongRunningFunctionTool`)
   *   that returns no result pauses the turn, as ADK pauses an `LlmAgent`:
   *   the agent emits the call with its id in `longRunningToolIds` and ends
   *   the turn. A later user message answers it with a `functionResponse` of
   *   the same id; that turn hands the result to the runtime as a tool
   *   result in its user message (never in the instruction). The runtime
   *   sees only accepted answers: other `functionResponse` parts of the
   *   user's messages (duplicates, unknown or foreign ids, re-sends,
   *   confirmation answers, earlier turns' results) are removed from what
   *   the driver gets. A result over 64 KiB (UTF-8 bytes of JSON), or
   *   results over 256 KiB in one turn, end the turn with
   *   an `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE` error event before the
   *   runtime starts; a smaller answer for the same call can follow. A
   *   long-running tool that returns a result is a normal call.
   * - `toolContext.requestCredential()` is not supported (an external runtime
   *   cannot run ADK's credential flow): the call returns a
   *   `CREDENTIAL_REQUIRED` error to the runtime, and the turn ends with an
   *   `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED` error event. Give such tools
   *   their credentials up front.
   * - The invocation's plugins (`beforeToolCallback`, `afterToolCallback`,
   *   `onToolErrorCallback`) and this agent's
   *   {@link ExternalAgentConfig.beforeToolCallback} and
   *   {@link ExternalAgentConfig.afterToolCallback} run around every call,
   *   in ADK's order.
   */
  tools?: ToolUnion[];
  /**
   * Tools that stay available when the effective policy is `read-only`, by
   * original tool name (the name before the bridge adds `adk_tool__`).
   *
   * @remarks
   * Listing a tool is your declaration that it has no side effects. The
   * bridge cannot verify it: a tool is host code that runs in the host
   * process with the host's authority, outside every runtime sandbox, and
   * `permissions.mode: "read-only"` only constrains the runtime's own tools.
   * What the bridge guarantees is that, in `read-only`, only listed tools are
   * exposed, that a declaration naming no tool is caught, and that nothing is
   * dropped silently:
   * - an agent whose own mode is `read-only` throws
   *   `EXTERNAL_AGENT_TOOL_NOT_READ_ONLY` for a direct tool that is not listed;
   * - an entry that is empty, listed twice, names no direct tool (when `tools`
   *   has no toolset) or names two or more direct tools throws
   *   `EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN`;
   * - an entry names one tool: when a listed name resolves to more than one
   *   tool in a run (a direct tool plus a toolset's, two toolsets), none of
   *   them is exposed and the name is reported as `ambiguous`;
   * - every tool hidden by an effective `read-only` policy (an inherited one
   *   included) is reported: one warning (`EXTERNAL_AGENT_TOOLS_HIDDEN`) per
   *   run when the tools are resolved, whatever the run does next; the final
   *   event's `customMetadata.externalAgentTools` (the last error event when
   *   there is no final text) when the run completes; and the span, when
   *   tracing is on.
   *
   * @defaultValue `[]`
   */
  readOnlyTools?: readonly string[];
  /**
   * Callbacks run before each call of a bridged ADK tool (see
   * {@link ExternalAgentConfig.tools}), after the plugins' `beforeToolCallback`,
   * as in `LlmAgent`. The first one that returns a response replaces the
   * call: the tool does not run and the runtime gets that response. A
   * callback that throws fails the call with `CALLBACK_FAILED`, and the tool
   * does not run. The runtime's own tools (Read, Bash...) do not go through
   * them.
   */
  beforeToolCallback?: BeforeToolCallback;
  /**
   * Callbacks run after each call of a bridged ADK tool, after the plugins'
   * `afterToolCallback`, as in `LlmAgent`. The first one that returns a
   * response replaces the result the runtime gets. A callback that throws
   * fails the call with `CALLBACK_FAILED`.
   */
  afterToolCallback?: AfterToolCallback;
}

/**
 * ADK agent backed by an external runtime driver (Claude, Codex, Gemini CLI...).
 *
 * As a `BaseAgent` it is also a `BaseNode`: ADK's inherited `runImpl` delegates
 * to `runAsync`, so no override is needed to drop it into a `Workflow`.
 *
 * See {@link ExternalAgentConfig} for how `clone()` treats the driver.
 */
export class ExternalAgent extends BaseAgent<ExternalAgentConfig> {
  /** The external runtime provider. */
  readonly provider: ExternalAgentProviderDefinition;
  /** The driver that runs the runtime. */
  readonly driver: ExternalAgentDriver;
  /** Supplies the runtime's credential. */
  readonly credentialProvider: ExternalAgentCredentialProvider;
  /** System instruction passed to the runtime. */
  readonly instruction?: string;
  /** Directory the runtime works in. */
  readonly workingDirectory?: string;
  /**
   * The agent's own permission policy, before ancestor capping: a frozen
   * copy of `config.permissions` taken at construction.
   */
  readonly permissions?: ExternalAgentPermissionPolicy;
  /** Delegation behavior when sub-agents are present. */
  readonly delegation?: DelegationOptions;
  /** How the runtime's permission prompts are answered. */
  readonly confirmation?: ExternalAgentConfirmationOptions;
  /** ADK tools and toolsets exposed to the runtime. */
  readonly tools: ToolUnion[];
  /** Names of the tools that stay available under `read-only`. */
  readonly readOnlyTools: readonly string[];
  /** Agent callbacks run before each bridged ADK tool call, in order. */
  readonly beforeToolCallbacks: readonly SingleBeforeToolCallback[];
  /** Agent callbacks run after each bridged ADK tool call, in order. */
  readonly afterToolCallbacks: readonly SingleAfterToolCallback[];

  /**
   * Creates an external agent.
   *
   * @param config - Agent options. The whole object is forwarded to
   * `BaseAgent` so `clone()` can rebuild the agent.
   * @throws InputValidationError (from `@google/adk`) when `permissions` is
   * set but malformed: an unknown `mode`, a non-boolean `allowNetwork`, an
   * `allowedPaths` or `readPaths` that is not an array of strings, a
   * `pathBounds` or `readPathBounds` that is not an array of string arrays,
   * or `readPaths` without `allowedPaths`.
   */
  constructor(config: ExternalAgentConfig) {
    super(config);
    this.provider = config.provider;
    this.driver =
      config.driver ?? new PlaceholderExternalAgentDriver(config.provider.id);
    this.credentialProvider =
      config.credentialProvider ?? new NoopCredentialProvider();
    this.instruction = config.instruction;
    this.workingDirectory = config.workingDirectory;
    // Keep the frozen copy: later changes to `config` do not reach the agent.
    this.permissions = assertPermissionPolicy(
      config.permissions,
      `ExternalAgent "${this.name}"`,
    );
    this.delegation = config.delegation;
    this.confirmation = config.confirmation;
    this.tools = config.tools ?? [];
    this.readOnlyTools = Object.freeze([...(config.readOnlyTools ?? [])]);
    this.assertToolDeclarations();
    this.beforeToolCallbacks = asCallbackList(config.beforeToolCallback);
    this.afterToolCallbacks = asCallbackList(config.afterToolCallback);
    brandExternalAgent(this);
  }

  /**
   * Refuses configurations that could only be ignored silently: tools or an
   * approver (or ADK confirmation) on a driver that cannot honor them,
   * `readOnlyTools` entries that do not name exactly one tool, and (under the
   * agent's own `read-only` mode) direct tools that are not listed. In that
   * order, so a typo in `readOnlyTools` is reported as unknown before an
   * undeclared tool.
   */
  private assertToolDeclarations(): void {
    const driver = this.driver;
    if (this.tools.length > 0 && typeof driver.capabilities === "function") {
      if (driver.capabilities().tools !== true) {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_TOOLS_UNSUPPORTED,
          `ExternalAgent "${this.name}": ${driver.constructor.name} cannot host ADK tools, so \`tools\` would be ignored. Use ClaudeAgent (ClaudeAgentSdkDriver), or remove \`tools\`.`,
        );
      }
    }
    // Only a driver that calls `request.requestPermission` ever reaches the
    // approver or ADK's confirmation protocol.
    if (
      (typeof this.confirmation?.approver === "function" ||
        this.confirmation?.adk === true) &&
      typeof driver.capabilities === "function" &&
      driver.capabilities().approvals !== true
    ) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_APPROVALS_UNSUPPORTED,
        `ExternalAgent "${this.name}": ${driver.constructor.name} never asks the host for permission, so \`confirmation\` would be ignored and the runtime would decide alone. Use ClaudeAgent (ClaudeAgentSdkDriver), or remove \`confirmation\`.`,
      );
    }

    const direct = this.tools.filter(isBaseTool);
    const hasToolset = this.tools.some(isBaseToolset);
    const counts = new Map<string, number>();
    for (const tool of direct) {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    }
    const unknownCode = EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN;
    const where = `ExternalAgent "${this.name}"`;
    const listed = this.readOnlyTools;
    const sorted = (names: Iterable<string>) =>
      [...new Set(names)].sort().join(", ");

    const invalid = listed.filter(
      (entry) => typeof entry !== "string" || entry.length === 0,
    );
    if (invalid.length > 0) {
      throw new ExternalAgentPolicyError(
        unknownCode,
        `${where}: readOnlyTools entries must be non-empty strings.`,
      );
    }
    const seen = new Set<string>();
    const repeated = listed.filter((entry) => {
      const again = seen.has(entry);
      seen.add(entry);
      return again;
    });
    if (repeated.length > 0) {
      throw new ExternalAgentPolicyError(
        unknownCode,
        `${where}: readOnlyTools lists ${sorted(repeated)} more than once.`,
      );
    }
    const ambiguous = listed.filter((entry) => (counts.get(entry) ?? 0) > 1);
    if (ambiguous.length > 0) {
      const entry = [...new Set(ambiguous)].sort()[0] as string;
      throw new ExternalAgentPolicyError(
        unknownCode,
        `${where}: readOnlyTools entry "${entry}" is ambiguous: ${counts.get(entry)} tools are named ${entry}; a read-only declaration must name exactly one tool.`,
      );
    }
    if (!hasToolset) {
      const unmatched = listed.filter((entry) => !counts.has(entry));
      if (unmatched.length > 0) {
        throw new ExternalAgentPolicyError(
          unknownCode,
          `${where}: readOnlyTools names no tool of this agent: ${sorted(unmatched)}.`,
        );
      }
    }

    if (this.permissions?.mode === "read-only") {
      const declared = new Set(listed);
      const undeclared = direct
        .map((tool) => tool.name)
        .filter((name) => !declared.has(name));
      if (undeclared.length > 0) {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_TOOL_NOT_READ_ONLY,
          `${where} runs in read-only mode, so these tools could never run: ${sorted(undeclared)}. Add a tool to readOnlyTools if it has no side effects, or remove it.`,
        );
      }
    }
  }

  /**
   * Runs one turn: resolves credentials and the effective permissions, starts
   * the driver and converts its events to ADK events.
   *
   * @remarks
   * The credential is read once into a frozen copy that the driver gets. A
   * `null` credential counts as none. A credential whose `kind` is not
   * `"env"` or `"none"`, or that is not an object, ends the turn with one
   * `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED` error event, before the driver
   * starts.
   * Abandoning the generator cancels the driver. The run ends early, without
   * an error, when a permission confirmation, a sub-agent interrupt or a
   * pending long-running tool call pauses the turn on the user.
   *
   * @param context - The ADK invocation context.
   * @returns The ADK events of the turn.
   */
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Read once into a frozen copy: the check and the driver see the same
    // credential, whatever getters the provider's object has.
    const snapshot = snapshotCredential(
      await this.credentialProvider.getCredential({
        providerId: this.provider.id,
        envAllowlist: this.provider.envAllowlist,
      }),
    );
    // Fail closed: a credential no driver can deliver must not silently fall
    // back to the runtime's own login.
    if ("unsupportedKind" in snapshot) {
      const refusal = this.toAdkEvent(
        policyErrorEvent(
          new ExternalAgentPolicyError(
            EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED,
            `Credential kind ${snapshot.unsupportedKind} for provider "${this.provider.id}" is not supported. Return an "env" credential, a "none" credential or undefined.`,
          ),
        ),
        context,
      );
      if (refusal) yield refusal;
      return;
    }
    const credential = snapshot.credential;
    // Results the user sent on this turn for long-running calls this agent
    // paused on earlier. They reach the runtime only as the user message's
    // tool results (data); the instruction gets a fixed note. Fail closed on
    // oversized results, before the driver starts and without marking them
    // used, so a smaller answer for the same call can follow.
    const longRunningResults = readLongRunningResults(context, this.name);
    const oversized = findOversizedResults(longRunningResults);
    if (oversized) {
      const refusal = this.toAdkEvent(
        {
          type: "error",
          code: EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE,
          message: oversized,
          recoverable: false,
        },
        context,
      );
      if (refusal) yield refusal;
      return;
    }
    // Never more permissive than the delegating parent, whatever agents ADK put
    // in between (see permissions/inheritance.ts), and never more permissive
    // than the ExternalAgents above it in the tree, even when ADK routes a turn
    // straight to this agent (a resumable app resuming its confirmation) and
    // the session carries no inherited policy.
    const permissions = resolveEffectivePermissions(
      context.session,
      ancestryPermissions(this),
      this,
    );

    // Own controller so abandoning the generator (iterator.return(), e.g. a
    // ParallelAgent sibling failing or the client disconnecting) cancels the
    // driver. It is linked to the Runner's signal so upstream aborts propagate.
    const controller = new AbortController();
    const abortSignal = context.abortSignal
      ? AbortSignal.any([context.abortSignal, controller.signal])
      : controller.signal;
    let driverDone = false;
    // A sub-agent paused on the user (confirmation, input, credential,
    // long-running call): its request event is already on the timeline, so the
    // coordinator stops, as ADK ends an invocation on a long-running call.
    let subAgentInterrupted = false;

    const queue = new AsyncQueue<Event>();
    const tracer = new ExternalAgentRunTracer({
      context,
      providerId: this.provider.id,
      requestModel: this.driver.model,
    });
    // The last non-partial text is held until the next event with content,
    // so the run's usage (reported by `completed`) can ride on the final ADK
    // event. A state-only event (e.g. the session id the Claude SDK reports
    // right before `completed`) passes ahead of it without releasing it. An
    // event is never changed after it is pushed: the Runner may already have
    // stored it.
    let heldFinal: Event | undefined;
    // The run's last error event is held the same way, so the model info can
    // ride on it when the run has no final text.
    let heldError: Event | undefined;
    let startedEvent: ExternalAgentStartedEvent | undefined;
    // Events queued and events the consumer has taken back control after.
    // The Runner stores a non-partial event before it asks for the next one,
    // so once both counts match, everything queued so far is in the session.
    let queued = 0;
    let delivered = 0;
    let consumerGone = false;
    const drainWaiters: Array<() => void> = [];
    const enqueue = (event: Event) => {
      queued++;
      queue.push(event);
    };
    const releaseDrained = () => {
      if (consumerGone || delivered >= queued) {
        for (const resolve of drainWaiters.splice(0)) resolve();
      }
    };
    const waitForTimeline = (): Promise<void> =>
      consumerGone || delivered >= queued
        ? Promise.resolve()
        : new Promise((resolve) => drainWaiters.push(resolve));
    const flushHeld = () => {
      if (heldFinal) {
        enqueue(heldFinal);
        heldFinal = undefined;
      }
      if (heldError) {
        enqueue(heldError);
        heldError = undefined;
      }
    };
    const push = (event: Event) => {
      if (!isStateOnlyEvent(event)) flushHeld();
      enqueue(event);
    };
    const rootAgent = this.rootAgent;
    const subAgents = this.subAgents;
    // The same gateway settings serve delegation and bridged-tool transfers.
    const makeGateway = (): ToolGateway =>
      new ToolGateway({
        rootAgent,
        subAgents,
        parentContext: context,
        parentPermissions: permissions,
        delegation: this.delegation,
        onInterrupt: () => {
          subAgentInterrupted = true;
          context.endInvocation = true;
          controller.abort();
        },
        // Sub-agents trace their own model calls (one span per call); the
        // delegation itself is traced by `traceDelegation`.
        eventSink: (event) => push(event),
        traceDelegation: (info, run) => tracer.traceDelegation(info, run),
        waitForTimeline,
      });
    const toolGateway = subAgents.length > 0 ? makeGateway() : undefined;

    // Answers the human gave on this turn to confirmation requests this agent
    // emitted earlier. Each approves/rejects one retry of the same call.
    const answers = readConfirmationAnswers(context, this.name);
    const answered = new Map(
      answers.map((answer) => [answer.signature, answer]),
    );
    // Hint of the answer each request was decided with, by request id, so a
    // bridged tool's re-run gets it in `toolContext.toolConfirmation`.
    const answerHints = new Map<string, string>();
    if (answers.length > 0) {
      const consumed = createAnswersConsumedEvent({
        context,
        agentName: this.name,
        answers,
      });
      tracer.traceMarker(consumed);
      push(consumed);
    }
    let confirmationRequested = false;
    // The driver sees only the accepted results among the user's
    // `functionResponse` parts (see driverContextFor).
    const driverContext = driverContextFor(context, longRunningResults);
    if (longRunningResults.length > 0) {
      const consumed = createResultsConsumedEvent({
        context,
        agentName: this.name,
        results: longRunningResults,
      });
      tracer.traceMarker(consumed);
      push(consumed);
    }
    // A bridged long-running tool returned no result: the turn pauses on it.
    let toolPending = false;
    // Tools that asked for credentials the runtime cannot provide.
    const credentialRequests: string[] = [];
    const notes = [
      answers.length ? describeAnswers(answers) : undefined,
      longRunningResults.length ? LONG_RUNNING_RESULTS_NOTE : undefined,
    ].filter((part): part is string => Boolean(part));
    const instruction = notes.length
      ? [this.instruction, ...notes]
          .filter((part): part is string => Boolean(part))
          .join("\n\n")
      : this.instruction;

    // Runtime names of this run's bridged tools, exactly as the MCP bridge
    // exposes them. Read on the first request, when the tools are resolved.
    let bridgedNames: ReadonlySet<string> | undefined;
    const bridgeToolNames = (): ReadonlySet<string> => {
      bridgedNames ??= new Set([
        ...(adkTools?.declarations ?? []).map(
          (declaration) => `${BRIDGE_TOOL_PREFIX}${declaration.name}`,
        ),
        ...(toolGateway ? [`${BRIDGE_TOOL_PREFIX}run_adk_subagent`] : []),
      ]);
      return bridgedNames;
    };
    const requestPermission = async (
      request: PermissionRequest,
    ): Promise<PermissionDecision> => {
      const guarded = guardPermissionRequest(permissions, request, {
        workingDirectory: this.workingDirectory,
        bridgeToolNames: bridgeToolNames(),
      });
      if (guarded) {
        return guarded;
      }
      // Read-only takes no confirmations: what the guard lets through there
      // (a web tool with the network on) runs without asking anyone.
      if (readOnlyWebToolAllowed(permissions, request.toolName)) {
        return { behavior: "allow" };
      }
      const signature = permissionSignature(request.toolName, request.input);
      const answer = answered.get(signature);
      if (answer) {
        answered.delete(signature);
        if (answer.hint) answerHints.set(request.requestId, answer.hint);
        const payload =
          answer.payload !== undefined ? { payload: answer.payload } : {};
        return answer.confirmed
          ? { behavior: "allow", ...payload }
          : { behavior: "deny", message: "Rejected by the user.", ...payload };
      }
      const approver = this.confirmation?.approver;
      if (approver) {
        try {
          return normalizeDecision(await approver(request));
        } catch {
          return { behavior: "deny", message: "The approver failed." };
        }
      }
      if (this.confirmation?.adk && !confirmationRequested) {
        // ADK-native path: ask through `adk_request_confirmation`, end this
        // invocation, and let the next turn carry the human's answer.
        confirmationRequested = true;
        const event = createConfirmationRequestEvent({
          context,
          agentName: this.name,
          request,
        });
        tracer.traceMarker(event);
        push(event);
        context.endInvocation = true;
        controller.abort();
        return {
          behavior: "deny",
          message:
            "Waiting for the user to confirm this call. Stop now; the task resumes after the answer.",
        };
      }
      return {
        behavior: "deny",
        message: this.confirmation?.adk
          ? "Another confirmation is already pending."
          : "Denied: no approver is configured for this agent.",
      };
    };

    // Control actions of bridged ADK tools ride on the tool's own function
    // response. `skipSummarization` and `transferToAgent` also end the
    // external turn, as ADK's LlmAgent stops after such a response; a transfer
    // then runs the target agent inside this invocation. `escalate` alone
    // does not end it: an enclosing LoopAgent stops after this agent's turn.
    const pendingActions: TerminalToolActions[] = [];
    let terminal: TerminalToolActions | undefined;
    let terminalEnded = false;
    let ownTransferGateway: ToolGateway | undefined;
    const transferGateway = (): ToolGateway =>
      toolGateway ??
      // biome-ignore lint/suspicious/noAssignInExpressions: built once, on the first transfer check.
      (ownTransferGateway ??= makeGateway());
    const emitToolActions = (actions: {
      stateDelta?: Record<string, unknown>;
      artifactDelta?: Record<string, number>;
    }) => {
      const stateDelta = actions.stateDelta ?? {};
      const artifactDelta = actions.artifactDelta ?? {};
      if (
        Object.keys(stateDelta).length === 0 &&
        Object.keys(artifactDelta).length === 0
      ) {
        return;
      }
      push(
        createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          actions: createEventActions({ stateDelta, artifactDelta }),
        }),
      );
    };

    const resolution =
      this.tools.length > 0
        ? await this.resolveAdkTools(context, permissions)
        : undefined;
    const resolvedTools = resolution?.bridge;
    const toolsReport = resolution?.report;
    if (toolsReport) tracer.traceToolsReport(toolsReport);
    const adkTools = resolvedTools
      ? routeAdkToolActions(resolvedTools, {
          requestPermission,
          paused: () =>
            confirmationRequested ||
            subAgentInterrupted ||
            toolPending ||
            controller.signal.aborted,
          answerHint: (requestId) => answerHints.get(requestId),
          hasAnswer: (name, args) =>
            answered.has(
              permissionSignature(name, normalizeToolCallArgs(args)),
            ),
          canTransferTo: (agentName) =>
            transferGateway().canTransferTo(agentName),
          emitActions: emitToolActions,
          onPending: (call) => {
            // As ADK pauses an LlmAgent on a long-running call without a
            // result: the call goes on the timeline with its id in
            // `longRunningToolIds`, and the invocation ends.
            const event = createLongRunningCallEvent({
              context,
              agentName: this.name,
              ...call,
            });
            tracer.traceMarker(event);
            push(event);
            toolPending = true;
            context.endInvocation = true;
            controller.abort();
          },
          onCredentialRequired: (toolName) => {
            credentialRequests.push(toolName);
          },
          onControlActions: (name, actions) => {
            const entry: TerminalToolActions = {
              name,
              actions,
              endsTurn: Boolean(
                actions.skipSummarization || actions.transferToAgent,
              ),
            };
            pendingActions.push(entry);
            if (entry.endsTurn) terminal ??= entry;
          },
        })
      : undefined;

    const pushTurnError = (
      code: string,
      message: string,
      metadata: Record<string, unknown>,
    ) => {
      const event = this.toAdkEvent(
        { type: "error", code, message, recoverable: false },
        context,
      );
      if (!event) return;
      event.customMetadata = { ...event.customMetadata, ...metadata };
      push(event);
    };

    const pushActionsEvent = (entry: TerminalToolActions, base?: Event) => {
      const event =
        base ??
        createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
        });
      Object.assign(event.actions, entry.actions);
      push(event);
    };

    void (async () => {
      let failed = false;
      try {
        for await (const event of this.driver.run({
          provider: this.provider,
          context: driverContext,
          abortSignal,
          instruction,
          requestPermission,
          ...(adkTools
            ? {
                adkTools,
                emitStateDelta: (stateDelta: Record<string, unknown>) =>
                  emitToolActions({ stateDelta }),
              }
            : {}),
          workingDirectory: this.workingDirectory,
          credential,
          permissions,
          agent: this,
          rootAgent,
          subAgents,
          toolGateway,
        })) {
          // A driver-level completion event is authoritative. Some provider SDKs emit their
          // terminal result after the subprocess exits but keep the transport iterator open while
          // it waits for EOF. Waiting for that EOF strands ADK's Runner even though the turn is
          // already complete. Breaking here calls return() on the driver iterator, which lets the
          // provider release its transport in finally.
          if (event.type === "started") startedEvent = event;
          if (event.type === "completed") {
            tracer.onDriverEvent(event);
            const modelInfo = modelInfoFor(this.driver, startedEvent, event);
            const carrier = heldFinal ?? heldError;
            if (carrier) {
              carrier.customMetadata = {
                ...carrier.customMetadata,
                [EXTERNAL_AGENT_MODEL_METADATA_KEY]: modelInfo.info,
              };
              if (modelInfo.modelVersion !== undefined) {
                carrier.modelVersion = modelInfo.modelVersion;
              }
              if (toolsReport) {
                carrier.customMetadata = {
                  ...carrier.customMetadata,
                  [EXTERNAL_AGENT_TOOLS_METADATA_KEY]: toolsReport,
                };
              }
            }
            const usageMetadata = usageMetadataFor(event.usage);
            if (heldFinal && usageMetadata) {
              heldFinal.usageMetadata = usageMetadata;
            }
            // genai usage metadata has no cache-write field either: it rides
            // on customMetadata, merged with what the event already carries.
            if (
              heldFinal &&
              typeof event.usage?.cacheCreationInputTokens === "number"
            ) {
              heldFinal.customMetadata = withCacheCreation(
                heldFinal.customMetadata,
                event.usage.cacheCreationInputTokens,
              );
            }
            // genai usage metadata has no scope field: a session total is
            // labeled here so consumers do not add it to earlier runs.
            if (heldFinal && event.usage?.scope) {
              heldFinal.customMetadata = {
                ...heldFinal.customMetadata,
                externalAgentUsageScope: event.usage.scope,
              };
            }
            break;
          }
          if (confirmationRequested || subAgentInterrupted || toolPending) {
            break;
          }
          const pairedIndex =
            event.type === "tool_result" && !event.error
              ? pendingActions.findIndex((entry) =>
                  isBridgedToolName(event.name, entry.name),
                )
              : -1;
          if (pairedIndex >= 0) {
            // The actions ride on the tool's own result, the first successful
            // result of that tool still unpaired (a call that set actions
            // succeeded). Events before it (the text and call of the same
            // model message) are older than the call and pass, even when the
            // runtime ran the tool before reporting them. A runtime that never
            // reports the result gets the actions on an event of their own
            // when its stream ends.
            const [entry] = pendingActions.splice(pairedIndex, 1);
            const adkEvent = this.toAdkEvent(event, context);
            tracer.onDriverEvent(event, adkEvent);
            if (entry) pushActionsEvent(entry, adkEvent);
            if (entry?.endsTurn) {
              terminalEnded = true;
              controller.abort();
              break;
            }
            continue;
          }
          if (toolGateway) {
            // Native ADK transfer makes the sub-agent's turn the final answer
            // and the coordinator stays silent afterwards: drop the coordinator's
            // redundant re-narration (a terminal text turn right after a
            // successful delegation). Partial chunks always pass through, and any
            // other activity (a new tool call) means the coordinator is still
            // working.
            if (event.type === "output" && !event.partial) {
              if (toolGateway.consumeFinalAnswer()) {
                // Dropped from the timeline, but it was a model call.
                tracer.onDriverEvent(event);
                continue;
              }
            } else if (
              event.type === "tool_call" &&
              event.metadata?.builtin !== true
            ) {
              // The runtime's own tools (Read, Bash...) do not count as new
              // activity: a coordinator reading a file is not a new delegation.
              toolGateway.resetFinalAnswer();
            }
          }
          const adkEvent = this.toAdkEvent(event, context);
          tracer.onDriverEvent(event, adkEvent);
          if (adkEvent) {
            if (event.type === "output" && !event.partial) {
              flushHeld();
              heldFinal = adkEvent;
            } else if (event.type === "error") {
              flushHeld();
              heldError = adkEvent;
            } else {
              push(adkEvent);
            }
          }
        }
      } catch (error) {
        // After a confirmation request (ours or a sub-agent's) or a terminal
        // tool action we aborted the driver on purpose; its abort error is not
        // a failure of the turn.
        if (
          !confirmationRequested &&
          !subAgentInterrupted &&
          !toolPending &&
          !terminalEnded
        ) {
          failed = true;
          flushHeld();
          queue.fail(error);
        }
      }
      try {
        if (
          !failed &&
          !confirmationRequested &&
          !subAgentInterrupted &&
          !toolPending
        ) {
          for (const entry of pendingActions.splice(0)) {
            pushActionsEvent(entry);
          }
          // Fail closed: the turn must not look successful when an approved
          // call never ran, or a tool could not get its credentials.
          const unused = [...answered.values()].filter(
            (answer) => answer.confirmed,
          );
          if (unused.length > 0) {
            pushTurnError(
              EXTERNAL_AGENT_CONFIRMATION_UNUSED,
              `An approved call was not made again, so it did not run: ${unused
                .map((answer) => answer.toolName)
                .join(", ")}.`,
              {
                unusedConfirmations: unused.map((answer) => ({
                  toolName: answer.toolName,
                  requestCallId: answer.requestCallId,
                })),
              },
            );
          }
          if (credentialRequests.length > 0) {
            pushTurnError(
              EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED,
              `A tool asked for credentials, which this runtime cannot request, so the call had no result: ${[
                ...new Set(credentialRequests),
              ].join(", ")}.`,
              { tools: [...new Set(credentialRequests)] },
            );
          }
          terminalEnded = terminal !== undefined;
          const target = terminal?.actions.transferToAgent;
          if (target) {
            flushHeld();
            await transferGateway().transferToAgent(
              target,
              context.userContent ?? {
                role: "user",
                parts: [{ text: `Transferred from ${this.name}.` }],
              },
            );
          }
        }
      } catch (error) {
        flushHeld();
        queue.fail(error);
      } finally {
        tracer.finish();
        flushHeld();
        driverDone = true;
        // Closing in finally covers normal EOF, an explicit terminal event, cancellation, and an
        // iterator return. No consumer is left waiting on the queue.
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
        delivered++;
        releaseDrained();
      }
    } finally {
      consumerGone = true;
      releaseDrained();
      if (!driverDone) {
        controller.abort();
      }
    }
  }

  /**
   * Resolves the configured ADK tools for this invocation and applies the
   * permission policy: under `read-only` only `readOnlyTools` stay exposed,
   * and everything the policy hid is reported.
   */
  private async resolveAdkTools(
    context: InvocationContext,
    permissions: ExternalAgentPermissionPolicy | undefined,
  ): Promise<{ bridge: AdkToolBridge; report?: ExternalAgentToolsReport }> {
    const callbacks = {
      beforeToolCallbacks: this.beforeToolCallbacks,
      afterToolCallbacks: this.afterToolCallbacks,
    };
    if (permissions?.mode !== "read-only") {
      return {
        bridge: await createAdkToolBridge(this.tools, context, callbacks),
      };
    }
    // Filter on the tool objects by their original name BEFORE the bridge
    // names them: matching generated names (`adk_tool__get_2`) would let an
    // unrelated tool literally named `get_2` through `readOnlyTools: ["get"]`.
    const allowed = new Set(this.readOnlyTools);
    const seen = new Set<string>();
    const rejected = new Set<string>();
    const bridge = await createAdkToolBridge(this.tools, context, {
      ...callbacks,
      // A listed name attests one tool: the bridge exposes none of a name
      // that more than one resolved tool has.
      uniqueNames: allowed,
      filter: (tool) => {
        seen.add(tool.name);
        if (allowed.has(tool.name)) return true;
        rejected.add(tool.name);
        return false;
      },
    });
    const ambiguous = new Set(
      bridge.skipped
        .filter((entry) => entry.reason === "ambiguous")
        .map((entry) => entry.name),
    );
    const hidden = [...new Set([...rejected, ...ambiguous])].sort();
    const unmatched = this.readOnlyTools
      .filter((name) => !seen.has(name) && !ambiguous.has(name))
      .sort();
    if (hidden.length === 0 && unmatched.length === 0) return { bridge };
    const report: ExternalAgentToolsReport = {
      hidden,
      ...(ambiguous.size > 0 ? { ambiguous: [...ambiguous].sort() } : {}),
      ...(unmatched.length > 0 ? { unmatchedReadOnlyTools: unmatched } : {}),
      reason: "read-only",
    };
    // The one report that does not depend on how the run ends or on tracing:
    // the event copy needs a completed driver, the span copy a tracer.
    const parts = [
      hidden.length > 0 ? `hidden: ${hidden.join(", ")}` : "",
      report.ambiguous ? `ambiguous: ${report.ambiguous.join(", ")}` : "",
      unmatched.length > 0 ? `not found: ${unmatched.join(", ")}` : "",
    ].filter(Boolean);
    warn(
      LogCode.EXTERNAL_AGENT_TOOLS_HIDDEN,
      `ExternalAgent "${this.name}" runs under a read-only policy, so some ADK tools are not exposed (${parts.join("; ")}). Only tools in readOnlyTools stay available.`,
    );
    return { bridge, report };
  }

  /** Live mode is not supported natively; it runs the same turn as {@link ExternalAgent.runAsyncImpl}. */
  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }

  /**
   * Converts a driver event to an ADK event.
   *
   * @param event - The driver event.
   * @param context - The ADK invocation context.
   * @returns The ADK event, or `undefined` for `started` and `completed`,
   * which only drive tracing.
   */
  protected toAdkEvent(
    event: ExternalAgentEvent,
    context: InvocationContext,
  ): Event | undefined {
    switch (event.type) {
      case "output": {
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: { role: "model", parts: [{ text: event.content }] },
          partial: event.partial,
          turnComplete: event.turnComplete ?? !event.partial,
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
          // Same contract as ADK's LlmAgent-as-node wrapper: the final text of a
          // non-partial turn is the node output, so a downstream Workflow node
          // receives it. Ignored outside a Workflow.
          ...(event.partial
            ? {}
            : {
                output: this.nodeOutput(event.content),
                nodeInfo: { messageAsOutput: true },
              }),
        });
      }
      case "error":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          // An empty code counts as none, as in the event title.
          errorCode: event.code || EXTERNAL_AGENT_ERROR,
          errorMessage: event.message,
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "tool_call":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: this.toolCallToContent(event),
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "tool_result":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: this.toolResultToContent(event),
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "state_delta":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          actions: createEventActions({ stateDelta: event.stateDelta }),
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "started":
      case "completed":
        return undefined;
    }
  }

  /**
   * Node output for a final text turn, following ADK's `maybeSetOutput`
   * (workflow/run_llm_agent_as_node): with an `outputSchema` and non-blank text
   * the text is parsed as JSON; if parsing fails the raw text is kept and ADK's
   * output validation reports the mismatch. Integers beyond
   * `Number.MAX_SAFE_INTEGER` stay exact, as strings, in objects, arrays and
   * scalars alike.
   */
  private nodeOutput(text: string): unknown {
    if (this.outputSchema && text.trim()) {
      const parsed = parseJson(text);
      return parsed.ok ? parsed.value : text;
    }
    return text;
  }

  private toolCallToContent(
    event: Extract<ExternalAgentEvent, { type: "tool_call" }>,
  ): Content {
    return {
      role: "model",
      parts: [
        {
          functionCall: {
            id: event.callId,
            name: event.name,
            args: normalizeToolCallArgs(event.input),
          },
        },
      ],
    };
  }

  private toolResultToContent(
    event: Extract<ExternalAgentEvent, { type: "tool_result" }>,
  ): Content {
    // Arrays and primitives are wrapped, so `response` is always a record.
    const response = toResponseObject(event.result);
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: event.callId,
            name: event.name,
            response: event.error
              ? { ...response, error: event.error }
              : response,
          },
        },
      ],
    };
  }
}

/** Control actions a bridged ADK tool set, waiting for the tool's result. */
interface TerminalToolActions {
  /** Exposed name of the tool that set them. */
  name: string;
  actions: {
    escalate?: boolean;
    transferToAgent?: string;
    skipSummarization?: boolean;
  };
  /** `skipSummarization` or `transferToAgent`: the external turn ends. */
  endsTurn: boolean;
}

/** What {@link routeAdkToolActions} needs from the running turn. */
interface AdkToolActionHooks {
  /** The agent's permission handler (guard, approver, ADK confirmation). */
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** Whether the turn is pausing or ending (a confirmation is pending). */
  paused(): boolean;
  /**
   * Whether this turn holds the human's answer to a confirmation of this
   * call (same tool and arguments). Does not consume it.
   */
  hasAnswer(name: string, args: unknown): boolean;
  /** Hint of the human's answer that decided `requestId`, if any. */
  answerHint(requestId: string): string | undefined;
  /** Whether `agentName` is a valid transfer target. */
  canTransferTo(agentName: string): boolean;
  /** Publishes state and artifact changes on the agent's timeline. */
  emitActions(actions: {
    stateDelta?: Record<string, unknown>;
    artifactDelta?: Record<string, number>;
  }): void;
  /** Records control actions to put on the call's result. */
  onControlActions(name: string, actions: TerminalToolActions["actions"]): void;
  /** Pauses the turn on a long-running call that has no result yet. */
  onPending(call: {
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): void;
  /** Records a tool that asked for credentials (`CREDENTIAL_REQUIRED`). */
  onCredentialRequired(toolName: string): void;
}

/**
 * The `toolConfirmation` a bridged tool re-runs with: the decision, plus the
 * payload (an approver's or the human's) and the hint of the answer.
 */
function toolConfirmationFrom(
  decision: PermissionDecision,
  hint: string | undefined,
): { confirmed: boolean; hint?: string; payload?: unknown } {
  return {
    confirmed: decision.behavior === "allow",
    ...(hint ? { hint } : {}),
    ...(decision.payload !== undefined ? { payload: decision.payload } : {}),
  };
}

/**
 * Wraps the bridge so the actions a tool sets on its context follow ADK
 * semantics, whatever driver runs the call:
 *
 * - `stateDelta` and `artifactDelta` are published on the timeline (the
 *   artifacts were already saved through the artifact service by
 *   `toolContext.saveArtifact`). The driver gets an empty `stateDelta` back,
 *   so nothing is published twice.
 * - A `toolContext.requestConfirmation()` inside `execute` goes through the
 *   agent's permission handler (approver or ADK `adk_request_confirmation`),
 *   and the tool runs again with the decision (with the approver's or the
 *   human's `payload`, and the answer's `hint`), as ADK re-runs it. When the
 *   handler paused the turn, the call ends without a second run. When the
 *   turn already holds the human's answer (the ADK protocol resumed), the
 *   decision is taken first and the tool runs once, with it.
 * - `escalate`, `transferToAgent` and `skipSummarization` of a successful
 *   call are recorded for the call's result (see
 *   {@link AdkToolActionHooks.onControlActions}). A transfer to an unknown
 *   agent, or to the agent itself, fails the call instead.
 * - A `pending` long-running call pauses the turn
 *   ({@link AdkToolActionHooks.onPending}), and a `CREDENTIAL_REQUIRED`
 *   error is recorded for the end of the turn.
 */
function routeAdkToolActions(
  bridge: AdkToolBridge,
  hooks: AdkToolActionHooks,
): AdkToolBridge {
  return {
    declarations: bridge.declarations,
    skipped: bridge.skipped,
    has: (name) => bridge.has(name),
    async execute(name, args, invocation, options = {}) {
      let callOptions = options;
      if (
        !options.toolConfirmation &&
        bridge.has(name) &&
        (args === undefined || isPlainRecord(args)) &&
        hooks.hasAnswer(name, args)
      ) {
        // The ADK protocol resumed this call: decide first (the guard still
        // runs and the answer is used once), then run the tool once with the
        // decision, as ADK's resume does. A call the bridge would reject
        // (an unknown tool or arguments that are not an object) leaves the
        // answer for a well-formed retry.
        const requestId =
          options.functionCallId ?? `adk-bridge-${crypto.randomUUID()}`;
        const decision = await hooks.requestPermission({
          requestId,
          toolName: name,
          input: normalizeToolCallArgs(args),
        });
        callOptions = {
          ...options,
          functionCallId: requestId,
          toolConfirmation: toolConfirmationFrom(
            decision,
            hooks.answerHint(requestId),
          ),
        };
      }
      let result = await bridge.execute(name, args, invocation, callOptions);
      let earlierArtifacts: Record<string, number> = {};
      const confirmation = result.confirmation;
      if (
        result.status === "confirmationRequired" &&
        confirmation?.origin === "requestConfirmation" &&
        !callOptions.toolConfirmation
      ) {
        earlierArtifacts = result.actions.artifactDelta;
        const decision = await hooks.requestPermission({
          requestId: confirmation.functionCallId,
          toolName: name,
          input: normalizeToolCallArgs(args),
          title: confirmation.hint,
        });
        if (hooks.paused()) {
          hooks.emitActions({ artifactDelta: earlierArtifacts });
          const message =
            decision.behavior === "deny"
              ? decision.message
              : "The turn is ending.";
          return {
            status: "error",
            response: { error: message },
            actions: { ...result.actions, stateDelta: {} },
            error: { code: "ABORTED", message },
          };
        }
        result = await bridge.execute(name, args, invocation, {
          functionCallId: confirmation.functionCallId,
          toolConfirmation: toolConfirmationFrom(
            decision,
            hooks.answerHint(confirmation.functionCallId),
          ),
        });
      }
      hooks.emitActions({
        stateDelta: result.actions.stateDelta,
        artifactDelta: { ...earlierArtifacts, ...result.actions.artifactDelta },
      });
      const routed: AdkToolExecutionResult = {
        ...result,
        actions: { ...result.actions, stateDelta: {} },
      };
      if (result.status === "pending" && result.pending) {
        hooks.onPending({
          callId: result.pending.functionCallId,
          toolName: result.pending.toolName,
          args: normalizeToolCallArgs(args),
        });
        const message =
          "The call was started and runs in the background. Stop now; the task resumes when its result arrives.";
        return { ...routed, response: { status: "pending", message } };
      }
      if (result.error?.code === "CREDENTIAL_REQUIRED") {
        hooks.onCredentialRequired(
          name.startsWith(ADK_TOOL_PREFIX)
            ? name.slice(ADK_TOOL_PREFIX.length)
            : name,
        );
      }
      if (result.status !== "ok") return routed;
      const { escalate, transferToAgent, skipSummarization } = result.actions;
      if (transferToAgent && !hooks.canTransferTo(transferToAgent)) {
        const message = `Cannot transfer to agent ${transferToAgent}: it is not a known agent of this tree, or it is the current agent.`;
        return {
          status: "error",
          response: { error: message },
          actions: routed.actions,
          error: { code: "EXECUTION_FAILED", message },
        };
      }
      if (escalate || transferToAgent || skipSummarization) {
        hooks.onControlActions(name, {
          ...(escalate ? { escalate: true } : {}),
          ...(transferToAgent ? { transferToAgent } : {}),
          ...(skipSummarization ? { skipSummarization: true } : {}),
        });
      }
      return routed;
    },
  };
}

/** Normalizes an ADK single-or-list callback option to a list. */
function asCallbackList<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

/**
 * An event that only carries a `stateDelta` or an `artifactDelta`: no content,
 * no error, and no control action (escalate, transfer, skip summarization, long-running ids),
 * so its position relative to the held final text does not matter.
 */
function isStateOnlyEvent(event: Event): boolean {
  if ((event.content?.parts?.length ?? 0) > 0) return false;
  if (event.errorCode || event.errorMessage) return false;
  if ((event.longRunningToolIds?.length ?? 0) > 0) return false;
  const actions = event.actions;
  if (!actions) return false;
  if (
    actions.escalate ||
    actions.transferToAgent ||
    actions.skipSummarization ||
    Object.keys(actions.requestedAuthConfigs ?? {}).length > 0 ||
    Object.keys(actions.requestedToolConfirmations ?? {}).length > 0
  ) {
    return false;
  }
  return (
    Object.keys(actions.stateDelta ?? {}).length > 0 ||
    Object.keys(actions.artifactDelta ?? {}).length > 0
  );
}

function metadataForExternalEvent(
  agentName: string,
  event: ExternalAgentEvent,
): Record<string, unknown> {
  const metadata = "metadata" in event && event.metadata ? event.metadata : {};
  return {
    ...metadata,
    title:
      typeof metadata.title === "string"
        ? metadata.title
        : readableExternalEventTitle(agentName, event),
    externalAgent: true,
  };
}

function readableExternalEventTitle(
  agentName: string,
  event: ExternalAgentEvent,
): string {
  switch (event.type) {
    case "output": {
      const itemType = stringOrEmpty(event.metadata?.itemType);
      if (itemType) {
        return itemTitle(
          agentName,
          itemType,
          stringOrEmpty(event.metadata?.status),
        );
      }
      return textTitle(agentName, Boolean(event.partial));
    }
    case "error":
      return errorTitle(agentName, event.code);
    case "tool_call":
      return toolCallTitle(agentName, event.name, event.input);
    case "tool_result":
      return toolResponseTitle(agentName, event.name, event.result);
    case "state_delta":
      return `${agentName}: state update`;
    case "started":
      return `${agentName}: started`;
    case "completed":
      return `${agentName}: completed`;
  }
}

/**
 * The model info of one run, from the driver and the run's `started` and
 * `completed` events.
 *
 * @remarks
 * A routed run (`modelRouting: "plan-mode"`) and a driver that does not set
 * `reportsResolvedModel: true` are `unsupported`: whatever model their events
 * carry is ignored. `modelVersion` is set only for `reported`.
 */
function modelInfoFor(
  driver: ExternalAgentDriver,
  started: ExternalAgentStartedEvent | undefined,
  completed: ExternalAgentCompletedEvent,
): { info: ExternalAgentModelInfo; modelVersion?: string } {
  const requested =
    typeof driver.model === "string" && driver.model.length > 0
      ? { requested: driver.model }
      : {};
  if (started?.modelRouting === "plan-mode") {
    return { info: { ...requested, status: "unsupported" } };
  }
  if (driver.reportsResolvedModel !== true) {
    return { info: { ...requested, status: "unsupported" } };
  }
  const reported = completed.model ?? started?.model;
  if (typeof reported === "string" && reported.length > 0) {
    return {
      info: { ...requested, resolved: reported, status: "reported" },
      modelVersion: reported,
    };
  }
  return { info: { ...requested, status: "not-reported" } };
}
