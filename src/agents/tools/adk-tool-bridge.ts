/**
 * Bridge from ADK tools to external agent runtimes.
 *
 * Pure and driver-agnostic: it turns ADK tools (`BaseTool`, and every tool a
 * `BaseToolset` exposes) into
 *
 * 1. **portable declarations** `{ name, description, inputSchema }` with a
 *    standard JSON Schema, which a driver can advertise to an external CLI
 *    (for example over MCP), and
 * 2. an **executor** that runs a tool the CLI called, with a real ADK
 *    `Context` built on the current `InvocationContext`, so state and artifact
 *    deltas, confirmations and abort signals behave as they do in an
 *    `LlmAgent`. Both `requireConfirmation` and a
 *    `toolContext.requestConfirmation()` call inside `execute` come back as
 *    `confirmationRequired`, a `toolContext.requestCredential()` call as a
 *    `CREDENTIAL_REQUIRED` error, and a long-running tool that returns no
 *    result as `pending`. The executor only reports the other actions
 *    (`escalate`, `transferToAgent`, `skipSummarization`); acting on them is
 *    the caller's job (`ExternalAgent` does it).
 *
 * Each call runs the invocation's plugin tool callbacks and the agent tool
 * callbacks given to {@link createAdkToolBridge}, in ADK's order: plugin
 * `beforeToolCallback`, then the agent's; the tool (plugin
 * `onToolErrorCallback` when it throws); plugin `afterToolCallback`, then
 * the agent's. A before callback that returns a response replaces the call,
 * and an after callback that returns one replaces the result.
 *
 * Nothing here throws on tool failures: every outcome is a structured
 * {@link AdkToolExecutionResult}.
 *
 * @example
 * ```typescript
 * const bridge = await createAdkToolBridge(agent.tools, invocationContext);
 * advertise(bridge.declarations); // [{ name: "adk_tool__get_weather", ... }]
 *
 * const result = await bridge.execute(
 *   "adk_tool__get_weather",
 *   { city: "Paris" },
 *   invocationContext,
 *   { functionCallId: "call_1" },
 * );
 * if (result.status === "confirmationRequired") {
 *   // ask a human, then call execute again with { toolConfirmation }
 * }
 * ```
 */

import {
  type AuthConfig,
  type BaseTool,
  Context,
  type InvocationContext,
  isBaseTool,
  isBaseToolset,
  ReadonlyContext,
  type SingleAfterToolCallback,
  type SingleBeforeToolCallback,
  ToolConfirmation,
  type ToolUnion,
} from "@google/adk";
import { normalizeSchema } from "../../converters/schema.js";
import { isPlainRecord } from "../event-titles.js";

/** Prefix added to every exposed tool name. */
export const ADK_TOOL_PREFIX = "adk_tool__";

/**
 * Name of the in-process MCP server that hosts the bridged tools.
 *
 * @internal
 */
export const BRIDGE_MCP_SERVER = "adk_bridge";

/**
 * Prefix a runtime puts before a tool of the bridge's MCP server
 * (`mcp__adk_bridge__<tool>`).
 *
 * @internal
 */
export const BRIDGE_TOOL_PREFIX = `mcp__${BRIDGE_MCP_SERVER}__`;

/**
 * Whether a runtime tool name is the bridged tool `exposed`.
 *
 * @remarks
 * A runtime reports the exposed name itself or, when it hosts the bridge as
 * an MCP server, {@link BRIDGE_TOOL_PREFIX} followed by it. A tool of any
 * other MCP server with the same short name does not match.
 *
 * @param name - The name the runtime reported.
 * @param exposed - The bridged tool's exposed name.
 * @returns Whether they are the same tool.
 * @internal
 */
export function isBridgedToolName(name: string, exposed: string): boolean {
  return name === exposed || name === `${BRIDGE_TOOL_PREFIX}${exposed}`;
}

/** Longest tool name most external runtimes accept. */
const MAX_NAME_LENGTH = 64;

/** A tool declaration an external runtime can advertise to its model. */
export interface PortableToolDeclaration {
  /** Namespaced, collision-free name (`adk_tool__<original>`). */
  name: string;
  /** Tool description for the model. */
  description: string;
  /** Standard JSON Schema (`type: "object"`) of the tool arguments. */
  inputSchema: Record<string, unknown>;
}

/** A tool that was found but cannot be exposed. */
export interface SkippedTool {
  /** Original tool name (or a placeholder for non-tools). */
  name: string;
  /** Why it was skipped. */
  reason:
    | "no-declaration" // built-in / in-model tool: nothing to advertise
    | "not-a-tool" // e.g. a workflow node in the agent's tool list
    | "toolset-failed"; // a toolset could not list its tools
}

/** Subset of ADK `EventActions` produced by a tool call. */
export interface AdkToolActions {
  /** State changes the tool made. */
  stateDelta: Record<string, unknown>;
  /** Artifacts the tool saved (filename → version). */
  artifactDelta: Record<string, number>;
  /** Confirmations the tool requested, keyed by function call id. */
  requestedToolConfirmations: Record<
    string,
    { hint: string; confirmed: boolean; payload?: unknown }
  >;
  /** Set when the tool asked to skip the model summarization step. */
  skipSummarization?: boolean;
  /** Set when the tool asked to transfer to another agent. */
  transferToAgent?: string;
  /** Set when the tool asked to escalate. */
  escalate?: boolean;
  /**
   * Credentials the tool asked for with `toolContext.requestCredential()`,
   * keyed by function call id. Set only on a `CREDENTIAL_REQUIRED` error.
   */
  requestedAuthConfigs?: Record<string, AuthConfig>;
}

/**
 * Machine-readable failure classes of {@link AdkToolExecutionResult}.
 *
 * - `UNKNOWN_TOOL`: no bridged tool has that name.
 * - `INVALID_ARGUMENTS`: the arguments are not an object, or the tool's
 *   confirmation predicate rejected them.
 * - `EXECUTION_FAILED`: the tool threw and no `onToolErrorCallback` plugin
 *   gave a response.
 * - `CONFIRMATION_REJECTED`: a human or approver rejected the call.
 * - `ABORTED`: the invocation was aborted, or the turn is pausing.
 * - `CALLBACK_FAILED`: a plugin or agent tool callback threw. A failing
 *   before callback means the tool did not run.
 * - `CREDENTIAL_REQUIRED`: the tool asked for credentials with
 *   `toolContext.requestCredential()`. The bridge cannot ask the user for
 *   them, so the call has no result; the request is in
 *   `actions.requestedAuthConfigs`.
 */
export type AdkToolErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_ARGUMENTS"
  | "EXECUTION_FAILED"
  | "CONFIRMATION_REJECTED"
  | "ABORTED"
  | "CALLBACK_FAILED"
  | "CREDENTIAL_REQUIRED";

/** Outcome of {@link AdkToolBridge.execute}. */
export interface AdkToolExecutionResult {
  /**
   * - `ok`: the tool ran and `response` is its result.
   * - `confirmationRequired`: the tool gates on human approval and was NOT
   *   run; ask a human and call `execute` again with `toolConfirmation`.
   * - `error`: the tool did not run, or failed; see `error`.
   * - `pending`: a long-running tool (`isLongRunning`, such as ADK's
   *   `LongRunningFunctionTool`) started and returned no result yet; see
   *   `pending`. Its result arrives later, as a `functionResponse` with the
   *   same function call id. A long-running tool that returns a result is
   *   `ok`.
   */
  status: "ok" | "confirmationRequired" | "error" | "pending";
  /**
   * Function-response payload (always an object; a non-object tool result is
   * wrapped as `{ result }`, like ADK does). For errors it is `{ error }`.
   */
  response: Record<string, unknown>;
  /** What the tool changed (state, artifacts, requested confirmations, ...). */
  actions: AdkToolActions;
  /** Set when `status` is `"error"`. */
  error?: { code: AdkToolErrorCode; message: string };
  /** Set when `status` is `"confirmationRequired"`. */
  confirmation?: {
    functionCallId: string;
    hint: string;
    payload?: unknown;
    /**
     * What asked for the confirmation: the tool's `requireConfirmation`
     * option (the tool did not run), or a `toolContext.requestConfirmation()`
     * call inside `execute` (the tool ran up to that call). In both cases,
     * call `execute` again with `toolConfirmation`; the tool then sees the
     * decision in `toolContext.toolConfirmation`, as in ADK.
     */
    origin?: "requireConfirmation" | "requestConfirmation";
  };
  /** Set when `status` is `"pending"`. */
  pending?: {
    /** Id of the call; the later `functionResponse` carries it. */
    functionCallId: string;
    /** The tool's own name (not the exposed one). */
    toolName: string;
  };
}

/** Per-call options of {@link AdkToolBridge.execute}. */
export interface AdkToolExecuteOptions {
  /** Id of this call; defaults to a generated one. Keys confirmations. */
  functionCallId?: string;
  /**
   * A human decision for a previously reported `confirmationRequired` call.
   * `confirmed: true` lets the gated tool run; `confirmed: false` returns a
   * `CONFIRMATION_REJECTED` error without running it.
   */
  toolConfirmation?: { confirmed: boolean; hint?: string; payload?: unknown };
}

/** Tools resolved for one invocation. */
export interface AdkToolBridge {
  /** Declarations to advertise, in a stable order. */
  readonly declarations: readonly PortableToolDeclaration[];
  /** Tools that were found but cannot be exposed. */
  readonly skipped: readonly SkippedTool[];
  /** Whether `name` is one of {@link declarations}. */
  has(name: string): boolean;
  /**
   * Runs the tool exposed as `name` (a namespaced name from
   * {@link declarations}). Never throws.
   */
  execute(
    name: string,
    args: unknown,
    invocationContext: InvocationContext,
    options?: AdkToolExecuteOptions,
  ): Promise<AdkToolExecutionResult>;
}

/** Replaces characters most runtimes reject in tool names. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function declarationFor(tool: BaseTool): PortableToolDeclaration | undefined {
  const declaration = tool._getDeclaration();
  if (!declaration) return undefined;

  // `parametersJsonSchema` is already standard JSON Schema; otherwise the
  // Gemini-style `parameters` (UPPERCASE types) are normalized.
  const jsonSchema = declaration.parametersJsonSchema;
  const inputSchema =
    jsonSchema && typeof jsonSchema === "object" && !Array.isArray(jsonSchema)
      ? (jsonSchema as Record<string, unknown>)
      : (normalizeSchema(declaration.parameters) ?? {
          type: "object",
          properties: {},
        });

  return {
    name: tool.name,
    description: declaration.description ?? tool.description ?? "",
    inputSchema,
  };
}

function exposedName(original: string, taken: Set<string>): string {
  const base = `${ADK_TOOL_PREFIX}${sanitizeName(original)}`.slice(
    0,
    MAX_NAME_LENGTH,
  );
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `_${n}`;
    candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

function emptyActions(): AdkToolActions {
  return {
    stateDelta: {},
    artifactDelta: {},
    requestedToolConfirmations: {},
  };
}

function actionsFrom(context: Context): AdkToolActions {
  const source = context.eventActions;
  const confirmations: AdkToolActions["requestedToolConfirmations"] = {};
  for (const [id, c] of Object.entries(
    source.requestedToolConfirmations ?? {},
  )) {
    confirmations[id] = {
      hint: c.hint,
      confirmed: c.confirmed,
      ...(c.payload !== undefined ? { payload: c.payload } : {}),
    };
  }
  const actions: AdkToolActions = {
    stateDelta: { ...source.stateDelta },
    artifactDelta: { ...source.artifactDelta },
    requestedToolConfirmations: confirmations,
  };
  if (source.skipSummarization) actions.skipSummarization = true;
  if (source.transferToAgent) actions.transferToAgent = source.transferToAgent;
  if (source.escalate) actions.escalate = true;
  return actions;
}

function errorResult(
  code: AdkToolErrorCode,
  message: string,
  actions: AdkToolActions = emptyActions(),
): AdkToolExecutionResult {
  return {
    status: "error",
    response: { error: message },
    actions,
    error: { code, message },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Agent tool callbacks for bridged ADK tools, run after the plugins' callbacks
 * (`ExternalAgent` passes its `beforeToolCallback` / `afterToolCallback`).
 */
export interface AdkToolCallbacks {
  /** Run before each call, in order; the first response returned wins. */
  beforeToolCallbacks?: readonly SingleBeforeToolCallback[];
  /** Run after each call, in order; the first response returned wins. */
  afterToolCallbacks?: readonly SingleAfterToolCallback[];
}

/** A callback threw; the message names the tool and the callback kind. */
class ToolCallbackError extends Error {}

async function runBeforeCallbacks(
  tool: BaseTool,
  args: Record<string, unknown>,
  toolContext: Context,
  invocationContext: InvocationContext,
  callbacks: readonly SingleBeforeToolCallback[],
): Promise<Record<string, unknown> | undefined> {
  try {
    const fromPlugin =
      await invocationContext.pluginManager?.runBeforeToolCallback({
        tool,
        toolArgs: args,
        toolContext,
      });
    if (fromPlugin != null) return fromPlugin;
    for (const callback of callbacks) {
      const response = await callback({ tool, args, context: toolContext });
      if (response != null) return response;
    }
    return undefined;
  } catch (error) {
    throw new ToolCallbackError(
      `A beforeTool callback failed for ${tool.name}: ${messageOf(error)}`,
    );
  }
}

async function runAfterCallbacks(
  tool: BaseTool,
  args: Record<string, unknown>,
  toolContext: Context,
  invocationContext: InvocationContext,
  callbacks: readonly SingleAfterToolCallback[],
  result: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const fromPlugin =
      await invocationContext.pluginManager?.runAfterToolCallback({
        tool,
        toolArgs: args,
        toolContext,
        result,
      });
    if (fromPlugin != null) return fromPlugin;
    for (const callback of callbacks) {
      const response = await callback({
        tool,
        args,
        context: toolContext,
        response: result,
      });
      if (response != null) return response;
    }
    return undefined;
  } catch (error) {
    throw new ToolCallbackError(
      `An afterTool callback failed for ${tool.name}: ${messageOf(error)}`,
    );
  }
}

async function runToolErrorCallbacks(
  tool: BaseTool,
  args: Record<string, unknown>,
  toolContext: Context,
  invocationContext: InvocationContext,
  error: Error,
): Promise<Record<string, unknown> | undefined> {
  try {
    return (
      (await invocationContext.pluginManager?.runOnToolErrorCallback({
        tool,
        toolArgs: args,
        toolContext,
        error,
      })) ?? undefined
    );
  } catch (callbackError) {
    throw new ToolCallbackError(
      `An onToolError callback failed for ${tool.name}: ${messageOf(callbackError)}`,
    );
  }
}

/**
 * Shapes a tool result as an ADK `functionResponse.response` object.
 *
 * @remarks
 * A plain object (prototype `Object.prototype` or `null`) is used as is; an
 * array is wrapped as `{ results }`, as ADK does; anything else (a primitive,
 * `null`, a `Date`, a `Map`, a class instance) is wrapped as `{ result }`,
 * with `undefined` as `null`.
 *
 * @param value - The tool's result.
 * @returns A record usable as a function response.
 * @internal
 */
export function toResponseObject(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return value;
    }
  }
  if (Array.isArray(value)) return { results: value };
  return { result: value === undefined ? null : value };
}

/**
 * Resolves `tools` (tools and toolsets, as in `LlmAgent.tools`) for one
 * invocation and returns the bridge.
 *
 * Toolsets are listed with `getTools(new ReadonlyContext(invocationContext))`,
 * so their filters and prefixes apply. Closing toolsets stays with their
 * owner. Entries that are not tools (such as workflow nodes) and tools without
 * a model-facing declaration (built-in or in-model tools) are reported in
 * {@link AdkToolBridge.skipped}.
 *
 * @param tools - The agent's tool list.
 * @param invocationContext - Context used to list toolsets.
 * @param options - `filter` keeps only the tools it accepts. It sees each
 * tool, a toolset's tools included, by its own name before the bridge names
 * it; a tool it rejects is left out without a `skipped` entry.
 * `beforeToolCallbacks` and `afterToolCallbacks` are the agent's tool
 * callbacks (as in `LlmAgent`); they run after the plugins' callbacks of the
 * invocation's `pluginManager`. After callbacks see the results the tool
 * produced (`ok`, `EXECUTION_FAILED` as `{ error }`, and `{}` for a
 * long-running tool without a result) and a before callback's response; they
 * do not run for calls the bridge stops itself (unknown tool, bad arguments,
 * abort, a pending or rejected confirmation, a credential request).
 * @returns The bridge with the declarations to advertise and the executor.
 */
export async function createAdkToolBridge(
  tools: readonly ToolUnion[],
  invocationContext: InvocationContext,
  options: { filter?: (tool: BaseTool) => boolean } & AdkToolCallbacks = {},
): Promise<AdkToolBridge> {
  const skipped: SkippedTool[] = [];
  const resolved: BaseTool[] = [];
  const beforeCallbacks = options.beforeToolCallbacks ?? [];
  const afterCallbacks = options.afterToolCallbacks ?? [];

  for (const entry of tools) {
    if (isBaseTool(entry)) {
      resolved.push(entry);
    } else if (isBaseToolset(entry)) {
      try {
        resolved.push(
          ...(await entry.getTools(new ReadonlyContext(invocationContext))),
        );
      } catch {
        skipped.push({
          name: entry.constructor.name,
          reason: "toolset-failed",
        });
      }
    } else {
      skipped.push({
        name: (entry as { name?: string })?.name ?? "(unnamed)",
        reason: "not-a-tool",
      });
    }
  }

  const declarations: PortableToolDeclaration[] = [];
  const byName = new Map<string, BaseTool>();
  const taken = new Set<string>();

  for (const tool of resolved) {
    if (options.filter && !options.filter(tool)) {
      continue;
    }
    const declaration = declarationFor(tool);
    if (!declaration) {
      skipped.push({ name: tool.name, reason: "no-declaration" });
      continue;
    }
    const name = exposedName(tool.name, taken);
    declarations.push({ ...declaration, name });
    byName.set(name, tool);
  }

  return {
    declarations,
    skipped,
    has: (name) => byName.has(name),
    async execute(name, args, context, options = {}) {
      const tool = byName.get(name);
      if (!tool) {
        return errorResult("UNKNOWN_TOOL", `Unknown tool: ${name}`);
      }
      if (context.abortSignal?.aborted) {
        return errorResult("ABORTED", "The invocation was aborted.");
      }
      if (args !== undefined && !isPlainRecord(args)) {
        return errorResult(
          "INVALID_ARGUMENTS",
          `Arguments for ${tool.name} must be a JSON object.`,
        );
      }

      const functionCallId =
        options.functionCallId ?? `adk-bridge-${crypto.randomUUID()}`;
      const decision = options.toolConfirmation;
      const toolContext = new Context({
        invocationContext: context,
        functionCallId,
        ...(decision
          ? {
              toolConfirmation: new ToolConfirmation({
                hint: decision.hint,
                confirmed: decision.confirmed,
                payload: decision.payload,
              }),
            }
          : {}),
      });
      const callArgs = (args ?? {}) as Record<string, unknown>;

      try {
        const ran = await runTool(tool, callArgs, toolContext, context, {
          functionCallId,
          decision,
          beforeCallbacks,
        });
        if (ran.kind === "done") return ran.result;

        const altered = await runAfterCallbacks(
          tool,
          callArgs,
          toolContext,
          context,
          afterCallbacks,
          ran.response ?? {},
        );
        if (altered != null) {
          // A callback's response replaces the result, a failure's too.
          return {
            status: "ok",
            response: toResponseObject(altered),
            actions: actionsFrom(toolContext),
          };
        }
        if (ran.kind === "failed") {
          return errorResult(
            "EXECUTION_FAILED",
            ran.message,
            actionsFrom(toolContext),
          );
        }
        if (ran.response === undefined) {
          // A long-running tool started and has no result yet. Never report
          // it as a finished call with `{ result: null }`.
          return {
            status: "pending",
            response: {
              status: "pending",
              message: `${tool.name} is running in the background; its result arrives later.`,
            },
            actions: actionsFrom(toolContext),
            pending: { functionCallId, toolName: tool.name },
          };
        }
        return {
          status: "ok",
          response: ran.response,
          actions: actionsFrom(toolContext),
        };
      } catch (error) {
        if (error instanceof ToolCallbackError) {
          return errorResult(
            "CALLBACK_FAILED",
            error.message,
            actionsFrom(toolContext),
          );
        }
        return errorResult(
          "EXECUTION_FAILED",
          messageOf(error),
          actionsFrom(toolContext),
        );
      }
    },
  };
}

/**
 * Outcome of the before callbacks and the tool, before the after callbacks.
 *
 * - `done`: the bridge stopped the call itself (confirmation, credentials,
 *   bad arguments); no after callback runs.
 * - `response`: a before callback's response or the tool's result.
 *   `undefined` only for a long-running tool that returned nothing.
 * - `failed`: the tool threw and no plugin gave a response.
 */
type ToolRun =
  | { kind: "done"; result: AdkToolExecutionResult }
  | { kind: "response"; response: Record<string, unknown> | undefined }
  | { kind: "failed"; message: string; response: Record<string, unknown> };

async function runTool(
  tool: BaseTool,
  callArgs: Record<string, unknown>,
  toolContext: Context,
  context: InvocationContext,
  call: {
    functionCallId: string;
    decision: AdkToolExecuteOptions["toolConfirmation"];
    beforeCallbacks: readonly SingleBeforeToolCallback[];
  },
): Promise<ToolRun> {
  const { functionCallId, decision } = call;
  const replaced = await runBeforeCallbacks(
    tool,
    callArgs,
    toolContext,
    context,
    call.beforeCallbacks,
  );
  if (replaced != null) {
    return { kind: "response", response: toResponseObject(replaced) };
  }

  try {
    if (await tool.checkRequireConfirmation(callArgs, toolContext)) {
      if (!decision) {
        const hint = `Please approve or reject the tool call ${tool.name}().`;
        return {
          kind: "done",
          result: {
            status: "confirmationRequired",
            response: { error: "This tool call requires confirmation." },
            actions: actionsFrom(toolContext),
            confirmation: {
              functionCallId,
              hint,
              origin: "requireConfirmation",
            },
          },
        };
      }
      if (!decision.confirmed) {
        return {
          kind: "done",
          result: errorResult(
            "CONFIRMATION_REJECTED",
            `The call to ${tool.name} was rejected.`,
          ),
        };
      }
    }
  } catch (error) {
    // Argument validation inside the confirmation predicate (Zod).
    return {
      kind: "done",
      result: errorResult("INVALID_ARGUMENTS", messageOf(error)),
    };
  }

  let output: unknown;
  try {
    output = await tool.runAsync({ args: callArgs, toolContext });
  } catch (error) {
    if (!(error instanceof Error)) {
      const message = messageOf(error);
      return { kind: "failed", message, response: { error: message } };
    }
    const recovered = await runToolErrorCallbacks(
      tool,
      callArgs,
      toolContext,
      context,
      error,
    );
    if (recovered != null) {
      return { kind: "response", response: toResponseObject(recovered) };
    }
    return {
      kind: "failed",
      message: error.message,
      response: { error: error.message },
    };
  }

  const requested =
    toolContext.eventActions.requestedToolConfirmations?.[functionCallId];
  if (requested && !decision) {
    // ADK ends the turn on this request and drops the response and state
    // changes of the call; the call runs again with the human decision.
    // Saved artifacts cannot be unsaved, so their delta is kept.
    const actions = actionsFrom(toolContext);
    return {
      kind: "done",
      result: {
        status: "confirmationRequired",
        response: { error: "This tool call requires confirmation." },
        actions: {
          ...emptyActions(),
          artifactDelta: actions.artifactDelta,
          requestedToolConfirmations: actions.requestedToolConfirmations,
        },
        confirmation: {
          functionCallId,
          hint:
            requested.hint ||
            `Please approve or reject the tool call ${tool.name}().`,
          ...(requested.payload !== undefined
            ? { payload: requested.payload }
            : {}),
          origin: "requestConfirmation",
        },
      },
    };
  }

  const requestedAuth = toolContext.eventActions.requestedAuthConfigs ?? {};
  if (Object.keys(requestedAuth).length > 0) {
    // Fail closed: the bridge has no way to ask the user for credentials, so
    // the call must not look like it worked.
    const message = `${tool.name} needs credentials, which cannot be requested from this runtime; the call has no result.`;
    return {
      kind: "done",
      result: errorResult("CREDENTIAL_REQUIRED", message, {
        ...actionsFrom(toolContext),
        requestedAuthConfigs: { ...requestedAuth },
      }),
    };
  }

  if (output == null && tool.isLongRunning) {
    return { kind: "response", response: undefined };
  }
  return { kind: "response", response: toResponseObject(output) };
}
