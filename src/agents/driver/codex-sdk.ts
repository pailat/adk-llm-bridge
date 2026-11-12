import { warn } from "../../utils/log.js";
import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { networkAllowed } from "../permissions/network.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CODEX_PROVIDER } from "../provider/codex.js";
import type { AgentRuntimeCapabilities } from "../runtime/capabilities.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import type { CodexInputPart } from "./codex-input-mapper.js";
import {
  type CodexMcpLister,
  codexApprovalsReviewerOverrides,
  codexMcpDisableOverrides,
} from "./codex-mcp.js";
import {
  codexFailureMessage,
  codexThreadStartedId,
  normalizeCodexSdkEvent,
} from "./codex-message-mapper.js";
import {
  buildCodexEnv,
  type CodexBinaryResolution,
  resolveCodexBinary,
  withBinaryPathDirs,
} from "./codex-run-env.js";
import {
  CODEX_SDK_INPUT_NOT_DELIVERED,
  CODEX_SDK_UNCONTAINED,
  CONTAINED_CODEX_SDK_VERSION,
  CodexSdkInputError,
  containCodexSdkClient,
  installedCodexSdkVersion,
  SUPPORTED_CODEX_SDK_VERSIONS,
  threadUsesExec,
} from "./codex-sdk-exec.js";
import {
  CodexThreadTracker,
  codexStateKey,
  prepareCodexTurn,
} from "./codex-session.js";
import {
  assertModelOption,
  assertNoCodexConfigModelOverride,
  CODEX_MODEL_ENV,
  envNameIn,
  MODEL_ALIAS_DENYLIST,
  modelEnvRefusal,
} from "./model.js";
import { CODEX_SDK_OPTION_KEYS } from "./option-keys.js";
import {
  dependencyMissing,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
  networkUnenforceable,
  policyErrorEvent,
  unenforceablePathsRefusal,
  unsandboxedShellRefusal,
} from "./policy-errors.js";
import {
  agentWritableRoots,
  assertKnownDriverOptions,
  describeMissingExecutable,
  readCredentialEnv,
  removeUndefined,
  stringValue,
  validateDriverConfig,
} from "./shared.js";
import {
  type StrictBinaryCheck,
  strictBinaryRefusal,
} from "./strict-binary.js";

type CodexSdkApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
type CodexSdkSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
type CodexSdkModelReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
type CodexSdkWebSearchMode = "disabled" | "cached" | "live";
type CodexSdkConfigValue =
  | string
  | number
  | boolean
  | CodexSdkConfigValue[]
  | CodexSdkConfigObject;
type CodexSdkConfigObject = { [key: string]: CodexSdkConfigValue };

type CodexSdkOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  config?: CodexSdkConfigObject;
  /** Raw `--config key=value` overrides (`@openai/codex-sdk` 0.167+). */
  configOverrides?: string[];
  env?: Record<string, string>;
};

export type CodexSdkThreadOptions = {
  model?: string;
  sandboxMode?: CodexSdkSandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: CodexSdkModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexSdkWebSearchMode;
  webSearchEnabled?: boolean;
  approvalPolicy?: CodexSdkApprovalMode;
  additionalDirectories?: string[];
};

export type CodexSdkTurnOptions = {
  signal?: AbortSignal;
  outputSchema?: Record<string, unknown>;
};

export type CodexSdkThreadEvent = Record<string, unknown>;

export type CodexSdkInput = string | CodexInputPart[];

export type CodexSdkThreadLike = {
  readonly id?: string | null;
  runStreamed(
    input: CodexSdkInput,
    options?: CodexSdkTurnOptions,
  ): Promise<{ events: AsyncGenerator<CodexSdkThreadEvent> }>;
};

export type CodexSdkClientLike = {
  startThread(options?: CodexSdkThreadOptions): CodexSdkThreadLike;
  resumeThread(id: string, options?: CodexSdkThreadOptions): CodexSdkThreadLike;
};

type CodexSdkConstructor = new (
  options?: CodexSdkOptions,
) => CodexSdkClientLike;

type CodexSdkModuleLike = {
  Codex: CodexSdkConstructor;
};

export type { CodexBinaryResolution } from "./codex-run-env.js";

/** Every `?: boolean` option of the driver config, checked when the driver is built. */
const CODEX_SDK_BOOLEAN_OPTIONS = [
  "requireExplicitModel",
  "skipGitRepoCheck",
  "webSearchEnabled",
  "allowUnenforcedNetwork",
  "allowUnenforcedPaths",
  "allowUncontainedCodexSdk",
  "strictBinaryResolution",
] as const;

/**
 * Options for {@link CodexSdkDriver}.
 *
 * @remarks
 * Everything is optional. Without `allowNetwork: true` the driver fails closed:
 * it refuses a run it cannot keep off the network unless
 * `allowUnenforcedNetwork` is set (see that option). Codex runs file tools
 * without asking the bridge, so a policy with `allowedPaths` (or inherited
 * path bounds) is refused with `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` unless
 * `allowUnenforcedPaths` is set.
 */
export interface CodexSdkDriverConfig {
  /**
   * A prebuilt Codex client. When set, the driver uses it as is and cannot
   * add `configOverrides` to it, so a run without `allowNetwork: true` is
   * refused unless `allowUnenforcedNetwork` is set.
   *
   * When it is a `@openai/codex-sdk` client, the driver replaces its exec
   * with a contained copy on the first run (see {@link CodexSdkDriver}), so
   * the host's own later uses of the same client run through it too.
   */
  sdk?: CodexSdkClientLike;
  /** The `Codex` constructor to build the client with, instead of importing `@openai/codex-sdk`. */
  Codex?: CodexSdkConstructor;
  /**
   * Loads the `@openai/codex-sdk` module.
   *
   * @defaultValue A dynamic `import("@openai/codex-sdk")`. When it fails the
   * run ends with `EXTERNAL_AGENT_DEPENDENCY_MISSING`.
   */
  importSdk?: () => Promise<CodexSdkModuleLike>;
  /** Absolute path of the Codex binary; wins over `CODEX_EXECUTABLE` and `CODEX_CLI_PATH`. */
  codexPathOverride?: string;
  /**
   * Ambient environment the driver reads `PATH`, `HOME`, proxy variables and
   * the binary overrides from. The Codex process only gets an allowlisted
   * copy of it, never the whole environment.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
  /**
   * API base URL passed to the Codex client (sent as `openai_base_url`). It
   * decides which endpoint answers: an explicit, host-set route, not a model
   * id.
   */
  baseUrl?: string;
  /** API key passed to the Codex client; falls back to `CODEX_API_KEY` from the run credential. */
  apiKey?: string;
  /**
   * Codex `config` object passed to the client (for example `mcp_servers`).
   * Keys that set or route the model (`model`, `model_provider`,
   * `model_providers`, `oss_provider`, `openai_base_url`,
   * `chatgpt_base_url`, `model_catalog_json`, `model_catalog_url`, `profile`,
   * `profiles`, at any depth and in any spelling) are refused with
   * `EXTERNAL_AGENT_MODEL_OVERRIDE` when the driver is built: use `model`
   * and `baseUrl`.
   */
  config?: CodexSdkConfigObject;
  /**
   * Model id for new and resumed threads. A string of 1 to 256 characters
   * without whitespace or control characters, not starting with `-`;
   * anything else (including `""`, which the SDK would drop for the default
   * model) is refused with `EXTERNAL_AGENT_MODEL_INVALID` when the driver is
   * built.
   *
   * @defaultValue the model of the host `config.toml`, or Codex's default
   */
  model?: string;
  /**
   * Refuse to build the driver without a `model`:
   * `EXTERNAL_AGENT_MODEL_REQUIRED`.
   *
   * @defaultValue false
   */
  requireExplicitModel?: boolean;
  /** Reasoning effort for new and resumed threads. */
  modelReasoningEffort?: CodexSdkModelReasoningEffort;
  /** Skip Codex's check that the working directory is a git repository. */
  skipGitRepoCheck?: boolean;
  /**
   * Web search mode. Applied only when the permission policy allows network
   * access (`allowNetwork: true`); otherwise it is forced to `"disabled"`.
   */
  webSearchMode?: CodexSdkWebSearchMode;
  /** Legacy web search switch; applied only when the policy allows network access. */
  webSearchEnabled?: boolean;
  /** JSON Schema the final answer of every turn must match. */
  outputSchema?: Record<string, unknown>;
  /**
   * Computes the `session.state` key used to persist Codex thread IDs so a
   * subsequent invocation can call `resumeThread(savedId)` instead of starting
   * a fresh thread. Defaults to `"codex_thread:" + agentName`.
   */
  threadStateKey?: (agentName: string) => string;
  /**
   * Opt-in: without `allowNetwork: true`, run even where the driver cannot
   * enforce it. Without it such a run is refused with
   * `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`. It covers two cases:
   * - the `full-access` mode, which has no sandbox, so shell commands can
   *   reach the network;
   * - a failed listing of Codex's host MCP servers (see `listMcpServers`):
   *   the run goes on with a warning, and servers that were not listed stay
   *   enabled;
   * - a prebuilt `sdk` client, whose host MCP servers the driver cannot
   *   turn off.
   *
   * @defaultValue false
   */
  allowUnenforcedNetwork?: boolean;
  /**
   * Opt-in: run a policy with `allowedPaths` (or path bounds inherited from a
   * parent agent) although this driver cannot check tool paths against them.
   * Without it such a run is refused with
   * `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`. With it, the runtime's own sandbox
   * alone decides which paths the agent reaches.
   *
   * @defaultValue false
   */
  allowUnenforcedPaths?: boolean;
  /**
   * Opt-in: run an installed `@openai/codex-sdk` version the driver cannot
   * contain (any version other than 0.167.2, or one it cannot read) through
   * the SDK's own exec, **without the containment**. Without it such a run is
   * refused with `EXTERNAL_AGENT_DEPENDENCY_MISSING`.
   *
   * With it, a codex that exits, is aborted or closes stdin before it reads
   * the prompt can end the host process with an uncaught `EPIPE` from the
   * SDK. The driver logs one `CODEX_SDK_UNCONTAINED` warning per driver
   * instance. On 0.167.2 the option changes nothing: the contained exec is
   * still used, and a client whose exec it cannot contain is still refused.
   *
   * @defaultValue false
   */
  allowUncontainedCodexSdk?: boolean;
  /**
   * Opt-in: refuse a run with `MISSING_BINARY` instead of letting the SDK
   * fall back to the Codex binary it finds next to its own install, when no
   * binary was found outside the directories the agent can write and this
   * package's install, `@openai/codex-sdk`, `@openai/codex` or its platform
   * package is at or under the run's working directory or `allowedPaths`
   * (symlinks resolved), or `@openai/codex-sdk` cannot be located.
   *
   * @remarks
   * An explicit `codexPathOverride`, `CODEX_EXECUTABLE` or `CODEX_CLI_PATH`
   * is used as given. A prebuilt `sdk` client cannot be checked, so the
   * constructor throws `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for the pair.
   * It narrows the hole, it does not close it: an agent that can write the
   * installed packages can still change the JavaScript the next host start
   * loads (see the isolation guide). The check
   * inspects the SDK package as Node finds it from this package's install;
   * an SDK passed through `Codex` or `importSdk` is not inspected, so it must come from
   * that same install. A writable root nested inside a checked package
   * (for example its `vendor` directory) is refused too.
   *
   * @defaultValue false
   */
  strictBinaryResolution?: boolean;
  /**
   * Lists Codex's host MCP servers. Without `allowNetwork: true` each listed
   * server, and each key of `config.mcp_servers`, is turned off through the
   * client's `configOverrides` (`mcp_servers.<name>.enabled=false`), because
   * MCP servers run outside the Codex sandbox and can reach the network.
   *
   * @remarks
   * Not used with a prebuilt `sdk` client: the driver cannot add overrides
   * to a client it did not build. Without `allowNetwork: true` such a run is
   * refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, unless
   * `allowUnenforcedNetwork` is set.
   *
   * @defaultValue Runs `<codex> mcp list --json` with the binary, environment
   * (`PATH` included) and working directory the client gets.
   */
  listMcpServers?: CodexMcpLister;
}

/**
 * What `strictBinaryResolution` checks for Codex: `@openai/codex-sdk` takes
 * its binary from `@openai/codex` and that package's platform package.
 *
 * @internal
 */
export const CODEX_STRICT_BINARY_CHECK: StrictBinaryCheck = {
  runtime: "Codex",
  sdkPackage: "@openai/codex-sdk",
  binaryPackages: ["@openai/codex"],
  option: "codexPathOverride",
  envVar: "CODEX_EXECUTABLE",
};

/** How to install the Codex SDK, for the missing-dependency error. */
const CODEX_SDK_INSTALL = "npm install @openai/codex-sdk";

/**
 * Runs an external agent through the `@openai/codex-sdk` package.
 *
 * @remarks
 * The permission policy maps to Codex sandbox and approval modes (see
 * {@link mapPolicyToCodexSdkThreadOptions}). The driver fails closed: network
 * is off unless the policy sets `allowNetwork: true`, and it refuses runs
 * whose network it cannot keep off (`full-access` mode, or host
 * MCP servers it cannot turn off) with a typed policy error event unless
 * `allowUnenforcedNetwork` is set. The Codex
 * process gets an allowlisted environment, never the whole of `process.env`.
 * Thread ids are persisted in session state so later invocations resume the
 * same thread.
 *
 * The SDK writes the prompt to codex's stdin without handling a write error,
 * so a codex gone before it read the prompt would end the host with an
 * uncaught `EPIPE`. The driver replaces the client's exec with a contained
 * copy of the SDK 0.167.2 exec path: such a run ends with
 * `CODEX_SDK_INPUT_NOT_DELIVERED` (or `CODEX_SDK_ERROR` for a non-zero exit of
 * codex's own). The copy is used only on the installed SDK versions it was
 * copied from (0.167.2, read at run time); another version, or a client
 * whose exec it cannot contain, is refused with
 * `EXTERNAL_AGENT_DEPENDENCY_MISSING` before codex starts, unless
 * `allowUncontainedCodexSdk` runs another version uncontained. The copy is
 * temporary, until the SDK handles stdin errors itself.
 *
 * @example
 * ```ts
 * const driver = new CodexSdkDriver({ model: "gpt-5-codex" });
 * ```
 */
export class CodexSdkDriver {
  /** Provider id of the Codex runtime. */
  readonly providerId = CODEX_PROVIDER.id;
  readonly #sdk?: CodexSdkClientLike;
  readonly #Codex?: CodexSdkConstructor;
  readonly #importSdk: () => Promise<CodexSdkModuleLike>;
  readonly #codexPathOverride?: string;
  readonly #env: Record<string, string | undefined>;
  readonly #baseUrl?: string;
  readonly #apiKey?: string;
  readonly #config?: CodexSdkConfigObject;
  readonly #model?: string;
  readonly #modelReasoningEffort?: CodexSdkModelReasoningEffort;
  readonly #skipGitRepoCheck?: boolean;
  readonly #webSearchMode?: CodexSdkWebSearchMode;
  readonly #webSearchEnabled?: boolean;
  readonly #outputSchema?: Record<string, unknown>;
  readonly #threadStateKey: (agentName: string) => string;
  readonly #allowUnenforcedNetwork: boolean;
  readonly #allowUnenforcedPaths: boolean;
  readonly #allowUncontainedCodexSdk: boolean;
  #warnedUncontained = false;
  readonly #strictBinaryResolution: boolean;
  readonly #listMcpServers?: CodexMcpLister;

  /**
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when a boolean option
   * (see the config's `?: boolean` fields) is set to a non-boolean value such
   * as the string `"false"`.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when `strictBinaryResolution` is
   * set together with a prebuilt `sdk` client,
   * `EXTERNAL_AGENT_MODEL_OVERRIDE` when `config` sets or routes the model,
   * `EXTERNAL_AGENT_MODEL_INVALID` when `model` is not a model id, and
   * `EXTERNAL_AGENT_MODEL_REQUIRED` when `requireExplicitModel` is set and
   * `model` is absent.
   */
  constructor(config: CodexSdkDriverConfig = {}) {
    assertKnownDriverOptions("CodexSdkDriver", config, CODEX_SDK_OPTION_KEYS);
    validateDriverConfig("CodexSdkDriver", config, CODEX_SDK_BOOLEAN_OPTIONS);
    assertNoCodexConfigModelOverride("CodexSdkDriver", config.config);
    this.#model = assertModelOption(
      "CodexSdkDriver",
      config.model,
      config.requireExplicitModel ?? false,
      MODEL_ALIAS_DENYLIST.codex,
    );
    this.#sdk = config.sdk;
    this.#Codex = config.Codex;
    this.#importSdk = config.importSdk ?? importCodexSdk;
    this.#codexPathOverride = config.codexPathOverride;
    this.#env = config.env ?? process.env;
    this.#baseUrl = config.baseUrl;
    this.#apiKey = config.apiKey;
    this.#config = config.config;
    this.#modelReasoningEffort = config.modelReasoningEffort;
    this.#skipGitRepoCheck = config.skipGitRepoCheck;
    this.#webSearchMode = config.webSearchMode;
    this.#webSearchEnabled = config.webSearchEnabled;
    this.#outputSchema = config.outputSchema;
    this.#allowUnenforcedNetwork = config.allowUnenforcedNetwork ?? false;
    this.#allowUnenforcedPaths = config.allowUnenforcedPaths ?? false;
    // Only `true` enables it: a truthy value such as the string "false"
    // from an env-driven host must not turn the containment off.
    this.#allowUncontainedCodexSdk = config.allowUncontainedCodexSdk === true;
    this.#strictBinaryResolution = config.strictBinaryResolution ?? false;
    if (this.#strictBinaryResolution && this.#sdk) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        "CodexSdkDriver: strictBinaryResolution cannot check the binary of a prebuilt sdk client. Let the driver build the client (pass Codex or nothing), or drop strictBinaryResolution.",
      );
    }
    this.#listMcpServers = config.listMcpServers;
    this.#threadStateKey =
      config.threadStateKey ?? ((agentName) => `codex_thread:${agentName}`);
  }

  /** The configured model id (`gen_ai.request.model`), if any. */
  get model(): string | undefined {
    return this.#model;
  }

  /** `false`: Codex reports no model on any event. */
  get reportsResolvedModel(): boolean {
    return false;
  }

  /** Features this driver supports: streaming, sessions (thread resume) and permissions. */
  capabilities(): AgentRuntimeCapabilities {
    return {
      streaming: true,
      sessions: true,
      permissions: true,
    };
  }

  /**
   * Runs one turn and streams normalized events.
   *
   * @remarks
   * Never throws: failures become `error` events followed by a `completed`
   * event with `exitCode: 1`. A run that cannot honor the policy (an
   * unsandboxed shell, or no `allowNetwork: true` with host MCP servers that
   * cannot be turned off) is refused before the SDK starts, with an error
   * event carrying `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, or `MISSING_BINARY`
   * when the `codex` binary needed to list MCP servers is absent. A missing
   * `@openai/codex-sdk` package surfaces as
   * `EXTERNAL_AGENT_DEPENDENCY_MISSING`. Temporary files
   * made for image inputs are always removed.
   *
   * @param request - The run: permissions, credential, context and instruction.
   * @returns Events in order, ending with exactly one `completed` event.
   */
  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    const refusal =
      modelEnvRefusal(
        "CodexSdkDriver",
        this.buildEnv(request),
        envNameIn(CODEX_MODEL_ENV),
      ) ??
      unenforceablePathsRefusal(request.permissions, {
        runtime: "Codex",
        allowUnenforcedPaths: this.#allowUnenforcedPaths,
      }) ??
      unsandboxedShellRefusal(request.permissions, {
        runtime: "Codex",
        allowUnenforcedNetwork: this.#allowUnenforcedNetwork,
      });
    if (refusal) {
      yield policyErrorEvent(refusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }

    let configOverrides: readonly string[] = [];
    if (
      this.#sdk &&
      !networkAllowed(request.permissions) &&
      !this.#allowUnenforcedNetwork
    ) {
      // The driver cannot add overrides to a client it did not build, so the
      // host MCP servers would stay enabled.
      yield policyErrorEvent(
        networkUnenforceable(
          "Codex was given a prebuilt sdk client, so the driver cannot turn off its host MCP servers and the network cannot be kept off (it is off unless allowNetwork is true). Let the driver build the client, set allowNetwork: true, or build the driver with allowUnenforcedNetwork: true to run anyway.",
        ),
      );
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    let Codex: CodexSdkConstructor | undefined;
    if (!this.#sdk) {
      // A missing SDK package is reported first: it is the setup error to
      // fix, and the MCP listing below needs the binary the package ships.
      try {
        Codex = this.#Codex ?? (await this.loadConstructor());
      } catch (error) {
        yield this.errorEvent(error, request);
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      const binary = this.resolveCodexBinary(request);
      const strictRefusal =
        this.#strictBinaryResolution && binary.path === undefined
          ? strictBinaryRefusal(
              CODEX_STRICT_BINARY_CHECK,
              agentWritableRoots(request),
            )
          : undefined;
      if (strictRefusal) {
        yield policyErrorEvent(strictRefusal);
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      const missingBinary = () =>
        dependencyMissing(
          "binary",
          "The codex binary (needed to list MCP servers while the network is off)",
          "npm install -g @openai/codex",
          "set CODEX_EXECUTABLE to its path",
        );
      // Without a binary outside the workspace the listing is refused: a
      // bare `codex` would be looked up on PATH, which can name a directory
      // inside the workspace.
      const mcp =
        binary.path === undefined && !networkAllowed(request.permissions)
          ? { refusal: missingBinary() }
          : await codexMcpDisableOverrides(request.permissions, {
              command: binary.path ?? "codex",
              env: this.runEnv(request, binary),
              cwd: request.workingDirectory,
              lister: this.#listMcpServers,
              configuredNames: configuredMcpServerNames(this.#config),
              allowUnenforcedNetwork: this.#allowUnenforcedNetwork,
              runtime: "Codex",
              commandNotFound: missingBinary,
            });
      if (mcp.refusal) {
        yield policyErrorEvent(mcp.refusal);
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      configOverrides = mcp.overrides;
    }

    yield* runCodexTurn({
      request,
      open: () => {
        const sdk =
          this.#sdk ??
          new (Codex as CodexSdkConstructor)(
            this.buildClientOptions(request, configOverrides),
          );
        // The SDK writes the prompt to codex's stdin with no error listener,
        // so a codex that is gone before it read the prompt would end the host
        // with an uncaught EPIPE. Its exec is replaced by a contained copy.
        const containment = containCodexSdkClient(sdk);
        if (containment === "unknown-shape") {
          throw codexSdkUncontainable(installedCodexSdkVersion());
        }
        if (containment === "unsupported-version") {
          const installed = installedCodexSdkVersion();
          if (!this.#allowUncontainedCodexSdk) {
            throw codexSdkUnsupportedVersion(installed);
          }
          this.#warnUncontained(installed);
        }
        return {
          client: sdk,
          threadOptions: this.buildThreadOptions(request),
          verifyThread: (thread) => {
            if (
              containment === "contained" &&
              !threadUsesExec(thread, (sdk as { exec?: unknown }).exec)
            ) {
              throw codexSdkUncontainable(installedCodexSdkVersion());
            }
          },
        };
      },
      stateKey: codexStateKey(request, this.#threadStateKey),
      outputSchema: this.#outputSchema,
      normalize: (event) => normalizeCodexSdkEvent(event),
      describeError: (error) => this.errorEvent(error, request),
    });
  }

  /**
   * Options for the client built for one run.
   *
   * @param request - The run.
   * @param configOverrides - Raw `--config` values, such as the MCP server
   * disables computed without `allowNetwork: true`. Omitted when empty.
   * @returns The `Codex` constructor options.
   */
  buildClientOptions(
    request: ExternalAgentRunRequest,
    configOverrides: readonly string[] = [],
  ): CodexSdkOptions {
    const binary = this.resolveCodexBinary(request);
    // The reviewer pin comes last, so neither `config` nor a host
    // config.toml can turn approvals over to a model reviewer.
    const overrides = [
      ...configOverrides,
      ...codexApprovalsReviewerOverrides(request.permissions),
    ];
    return removeUndefined({
      codexPathOverride: binary.path,
      baseUrl: this.#baseUrl,
      apiKey: this.#apiKey ?? readCredentialEnv(request, "CODEX_API_KEY"),
      config: this.#config,
      configOverrides: overrides.length > 0 ? overrides : undefined,
      env: this.runEnv(request, binary),
    }) as CodexSdkOptions;
  }

  /**
   * {@link buildEnv} with the binary's own `PATH` directories in front, as
   * the SDK does for a binary it finds itself.
   */
  private runEnv(
    request: ExternalAgentRunRequest,
    binary: CodexBinaryResolution,
  ): Record<string, string> {
    return withBinaryPathDirs(this.buildEnv(request), binary.pathDirs);
  }

  /**
   * Thread options for one run: the sandbox and approval modes from the
   * permission policy plus the driver's model and web search settings.
   *
   * @remarks
   * Web search is dropped unless the policy grants network access, because
   * it needs egress the sandbox cannot give. Without network web search is
   * set to `"disabled"` so a host `config.toml` cannot turn it on.
   *
   * @param request - The run.
   * @returns Options for `startThread` and `resumeThread`.
   */
  buildThreadOptions(request: ExternalAgentRunRequest): CodexSdkThreadOptions {
    const policyOptions = mapPolicyToCodexSdkThreadOptions(request.permissions);
    // Web search needs network egress, which the sandbox grants only under
    // `allowNetwork: true`.
    const networkAccessEnabled = policyOptions.networkAccessEnabled === true;
    return removeUndefined({
      ...policyOptions,
      model: this.#model,
      workingDirectory: request.workingDirectory,
      skipGitRepoCheck: this.#skipGitRepoCheck,
      modelReasoningEffort: this.#modelReasoningEffort,
      // Without network web search is set to "disabled", so a host
      // config.toml cannot turn it on.
      webSearchMode: networkAccessEnabled ? this.#webSearchMode : "disabled",
      webSearchEnabled: networkAccessEnabled
        ? this.#webSearchEnabled
        : undefined,
    }) as CodexSdkThreadOptions;
  }

  /**
   * Finds the Codex binary.
   *
   * @remarks
   * Order: `codexPathOverride`, `CODEX_EXECUTABLE`, `CODEX_CLI_PATH` (driver
   * env, then the run credential), `PATH` and `node_modules/.bin`, then the
   * npm-installed `@openai/codex` package, both under the host process
   * directory and this package's install. It only checks that files exist.
   *
   * Security invariant: no candidate at or under a directory the agent may
   * write is searched or returned: the run's working directory (the process
   * directory when it is unset) and its `allowedPaths`, symlinks resolved.
   * The explicit paths above are used as given. When nothing is found, a run
   * that needs the MCP listing is refused with `MISSING_BINARY`; otherwise
   * the SDK looks for its own bundled binary next to its install, which the
   * agent can change if that install is inside the workspace (see the
   * isolation guide), unless `strictBinaryResolution` refuses the run.
   *
   * @param request - The run, for its credential, working directory and
   * permissions.
   * @returns The binary path (when found) and every location tried.
   */
  resolveCodexBinary(request: ExternalAgentRunRequest): CodexBinaryResolution {
    return resolveCodexBinary(request, this.#env, this.#codexPathOverride);
  }

  /**
   * Environment for the Codex process.
   *
   * @remarks
   * Security invariant: this is an allowlist, not a copy of `process.env`.
   * Only `PATH`, `HOME`, `USER`, `SHELL`, `XDG_CONFIG_HOME`, proxy and
   * certificate variables and `CODEX_HOME` are carried over, plus the keys in
   * the provider `envAllowlist` that an `env` credential supplies (these win
   * over the ambient values). Other secrets in the host environment never
   * reach the agent.
   *
   * @param request - The run, for its credential.
   * @returns The environment to pass to the client.
   */
  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    return buildCodexEnv(this.#env, request, { ambientPassthrough: true });
  }

  /**
   * Converts one Codex SDK thread event into zero or more driver events.
   *
   * @remarks
   * `turn.completed` becomes `completed` (with token usage), `turn.failed`
   * becomes `error` plus `completed` with `exitCode: 1`, and completed items
   * become `output`, `tool_call` and `tool_result` events. Unknown event types
   * are dropped. Error codes are `CODEX_TURN_FAILED`, `CODEX_SDK_STREAM_ERROR`
   * and `CODEX_ITEM_ERROR`.
   *
   * @param event - A raw thread event.
   * @returns The normalized events; empty when the event carries nothing.
   */
  normalizeEvent(event: CodexSdkThreadEvent): ExternalAgentEvent[] {
    return normalizeCodexSdkEvent(event);
  }

  private async loadConstructor(): Promise<CodexSdkConstructor> {
    let module: CodexSdkModuleLike;
    try {
      module = await this.#importSdk();
    } catch (error) {
      throw Object.assign(
        dependencyMissing(
          "package",
          "The Codex SDK (@openai/codex-sdk)",
          CODEX_SDK_INSTALL,
          "use driver: new CodexCliDriver(...)",
        ),
        { cause: error },
      );
    }
    return module.Codex;
  }

  /** Logs, once per driver, that a run goes through the SDK's own exec. */
  #warnUncontained(installed: string | undefined): void {
    if (this.#warnedUncontained) return;
    this.#warnedUncontained = true;
    warn(
      CODEX_SDK_UNCONTAINED,
      `CodexSdkDriver runs @openai/codex-sdk ${installedLabel(installed)} without the contained exec (allowUncontainedCodexSdk): a codex that exits, is aborted or closes stdin before it reads the prompt can end the host process with an uncaught EPIPE. Install @openai/codex-sdk@${CONTAINED_CODEX_SDK_VERSION} to restore the containment.`,
    );
  }

  /** The `error` event for a failure thrown inside a run. */
  private errorEvent(
    error: unknown,
    request: ExternalAgentRunRequest,
  ): ExternalAgentEvent {
    if (error instanceof ExternalAgentPolicyError) {
      return policyErrorEvent(error);
    }
    if (error instanceof CodexSdkInputError) {
      // Not through the message heuristics: stderr in the message could
      // read as a transport error, and a retry does not fix a codex that
      // stops before it reads its prompt.
      return {
        type: "error",
        message: error.message,
        code: CODEX_SDK_INPUT_NOT_DELIVERED,
        recoverable: false,
        timestamp: Date.now(),
      };
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    const { recoverable, code } = classifyRecoverable({
      message: rawMessage,
      fallbackCode: "CODEX_SDK_ERROR",
    });
    return {
      type: "error",
      message: this.describeError(error, request),
      code,
      recoverable,
      timestamp: Date.now(),
    };
  }

  private describeError(
    error: unknown,
    request: ExternalAgentRunRequest,
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to locate Codex CLI binaries")) {
      return message;
    }

    return describeMissingExecutable({
      headline: "Codex SDK could not locate a Codex binary.",
      hint: "Set CODEX_EXECUTABLE=/absolute/path/to/codex or CODEX_CLI_PATH=/absolute/path/to/codex, or reinstall @openai/codex with optional dependencies.",
      original: message,
      checked: this.resolveCodexBinary(request).checked,
    });
  }
}

/** Names of the MCP servers set in the driver's own `config.mcp_servers`. */
/**
 * What one Codex turn needs from the transport that feeds the shared loop.
 *
 * @internal
 */
export interface CodexTurnOptions {
  /** The run. */
  request: ExternalAgentRunRequest;
  /**
   * Builds the client for this run. Runs inside the loop's error handling, so
   * a refusal it throws becomes an `error` event. `verifyThread` runs on the
   * thread before the turn starts.
   */
  open: () => {
    client: CodexSdkClientLike;
    threadOptions: CodexSdkThreadOptions;
    verifyThread?: (thread: CodexSdkThreadLike) => void;
  };
  /** The session state key for the thread id; `undefined` keeps no state. */
  stateKey: string | undefined;
  /** JSON schema for the final answer, passed to the turn. */
  outputSchema?: Record<string, unknown>;
  /** Maps one stream event to bridge events (see the message mapper). */
  normalize: (event: CodexSdkThreadEvent) => ExternalAgentEvent[];
  /** Turns a thrown error into the one `error` event of the run. */
  describeError: (error: unknown) => ExternalAgentEvent;
  /**
   * End the stream without a `completed` event when the abort signal fires,
   * instead of reporting the abort as an error.
   */
  endOnAbort?: boolean;
  /**
   * Lets a transport have an error it threw reach the caller instead of
   * becoming an `error` event: returns the error to throw, or `undefined`.
   */
  rethrow?: (error: unknown) => { error: unknown } | undefined;
}

/**
 * The one agent run loop of the Codex drivers: starts or resumes the thread,
 * streams its events through `normalize`, saves the thread id as soon as it
 * is known, reports one error per failure, ends with exactly one `completed`
 * event, and always removes the turn's temporary files.
 *
 * @remarks
 * `CodexSdkDriver` feeds it the SDK's thread events; `CodexCliDriver` feeds it
 * a client whose threads run `codex exec --json`. Anything that is not about
 * how the events arrive lives here, so the two transports cannot drift apart.
 *
 * @param options - The run and the transport hooks.
 * @returns Bridge events in order, without the leading `started`.
 * @internal
 */
export async function* runCodexTurn(
  options: CodexTurnOptions,
): AsyncGenerator<ExternalAgentEvent> {
  const { request, normalize } = options;
  const signal = resolveAbortSignal(request);
  const endedByAbort = () => options.endOnAbort === true && signal?.aborted;
  let completed = false;
  let failed = false;
  let terminalEvent: ExternalAgentEvent | undefined;
  let cleanup: () => Promise<void> = async () => {};
  try {
    const { client, threadOptions, verifyThread } = options.open();
    const turn = prepareCodexTurn({
      client,
      request,
      stateKey: options.stateKey,
      threadOptions,
    });
    cleanup = turn.cleanup;
    verifyThread?.(turn.thread);

    const { events } = await turn.thread.runStreamed(turn.input, {
      signal,
      outputSchema: options.outputSchema,
    });

    // The `thread.started` event carries the id before the first turn
    // completes, so the `state_delta` goes out at once and a turn that fails
    // midway is still resumable.
    const tracker = new CodexThreadTracker(
      options.stateKey,
      turn.savedThreadId,
    );

    // One failure surfaces as a stream `error` followed by `turn.failed`.
    // Hold the stream error back until the next event: when that is the
    // `turn.failed` for the same failure (or one without a message), only
    // one error is emitted.
    let heldError: ExternalAgentEvent | undefined;
    stream: for await (const event of events) {
      if (endedByAbort()) {
        return;
      }
      const eventType = stringValue(event.type);
      if (eventType === "error") {
        if (heldError) {
          yield heldError;
        }
        heldError = normalize(event)[0];
        continue;
      }
      let current = event;
      if (heldError) {
        const previous = heldError;
        heldError = undefined;
        if (eventType !== "turn.failed" || previous.type !== "error") {
          yield previous;
        } else {
          const message = codexFailureMessage(event);
          if (message === undefined) {
            // Keep the stream error's message when `turn.failed` has none.
            current = { ...event, error: { message: previous.message } };
          } else if (message !== previous.message) {
            yield previous;
          }
        }
      }
      if (eventType === "thread.started") {
        const delta = tracker.observe(codexThreadStartedId(event));
        if (delta) {
          yield delta;
        }
      }
      for (const normalized of normalize(current)) {
        if (normalized.type === "completed") {
          terminalEvent = normalized;
          break stream;
        }
        yield normalized;
      }
    }
    if (heldError) {
      yield heldError;
    }
    if (endedByAbort()) {
      return;
    }

    // Fallback: if `thread.started` was never observed, persist the id from
    // the thread accessor.
    const lateDelta = tracker.observe(turn.thread.id);
    if (lateDelta) {
      yield lateDelta;
    }

    if (terminalEvent) {
      completed = true;
      yield terminalEvent;
    }
  } catch (error) {
    if (endedByAbort()) {
      return;
    }
    const fault = options.rethrow?.(error);
    if (fault) {
      throw fault.error;
    }
    failed = true;
    yield options.describeError(error);
  } finally {
    try {
      await cleanup();
    } catch {
      // best-effort cleanup; never let tmp deletion mask the real error.
    }
  }

  if (!completed) {
    yield {
      type: "completed",
      exitCode: failed ? 1 : 0,
      timestamp: Date.now(),
    };
  }
}

function configuredMcpServerNames(
  config: CodexSdkConfigObject | undefined,
): string[] {
  const servers = config?.mcp_servers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? Object.keys(servers)
    : [];
}

/**
 * Maps a permission policy to Codex thread options.
 *
 * @remarks
 * `read-only` runs in the read-only sandbox, `ask` and `workspace-write` in
 * the workspace-write sandbox, and `full-access` in `danger-full-access`
 * (no sandbox). Only `ask` asks for approval; the others never prompt.
 * `allowedPaths` carries over as additional writable directories. Network
 * access is on only for `allowNetwork: true`.
 *
 * @param permissions - The policy; when omitted the `read-only` mode applies.
 * @returns Sandbox, approval, network and directory options.
 */
export function mapPolicyToCodexSdkThreadOptions(
  permissions?: ExternalAgentPermissionPolicy,
): CodexSdkThreadOptions {
  const policy = permissions ?? { mode: "read-only" as const };
  const base = {
    networkAccessEnabled: networkAllowed(policy),
    additionalDirectories: policy.allowedPaths
      ? [...policy.allowedPaths]
      : undefined,
  };

  switch (policy.mode) {
    case "read-only":
      return removeUndefined({
        ...base,
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }) as CodexSdkThreadOptions;
    case "ask":
      return removeUndefined({
        ...base,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      }) as CodexSdkThreadOptions;
    case "workspace-write":
      return removeUndefined({
        ...base,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      }) as CodexSdkThreadOptions;
    case "full-access":
      return removeUndefined({
        ...base,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      }) as CodexSdkThreadOptions;
  }
}

/** The ways forward a Codex SDK refusal names. */
const CODEX_SDK_WAYS_FORWARD = `set allowUncontainedCodexSdk: true on CodexSdkDriver to run the installed SDK without the containment (a codex that stops before it reads the prompt can then end the host), or use driver: new CodexCliDriver(...)`;

function installedLabel(installed: string | undefined): string {
  return installed ?? "a version the driver could not read";
}

/**
 * The refusal for a Codex SDK client whose exec the driver cannot contain on
 * a supported version: its internals differ from the SDK version the
 * containment copies (for example a client from another SDK copy), so a
 * codex that stops before it reads the prompt could end the host.
 *
 * @param installed - The installed version, when it could be read.
 */
function codexSdkUncontainable(installed: string | undefined): Error {
  return dependencyMissing(
    "package",
    `A Codex SDK client whose exec matches @openai/codex-sdk ${CONTAINED_CODEX_SDK_VERSION} (installed: ${installedLabel(installed)}; pass a client from that install)`,
    `npm install @openai/codex-sdk@${CONTAINED_CODEX_SDK_VERSION}`,
    "use driver: new CodexCliDriver(...)",
  );
}

/**
 * The refusal for an installed Codex SDK version the contained exec was not
 * copied from: its exec may build a different command line, so the driver
 * does not run the copy for it, and runs it uncontained only on opt-in.
 *
 * @param installed - The installed version, when it could be read.
 */
function codexSdkUnsupportedVersion(installed: string | undefined): Error {
  const supported = SUPPORTED_CODEX_SDK_VERSIONS.join(" or ");
  return dependencyMissing(
    "package",
    `@openai/codex-sdk ${supported}, the only version${SUPPORTED_CODEX_SDK_VERSIONS.length > 1 ? "s" : ""} whose exec this driver guards (installed: ${installedLabel(installed)}),`,
    `npm install @openai/codex-sdk@${CONTAINED_CODEX_SDK_VERSION}`,
    CODEX_SDK_WAYS_FORWARD,
  );
}

async function importCodexSdk(): Promise<CodexSdkModuleLike> {
  return import("@openai/codex-sdk") as Promise<CodexSdkModuleLike>;
}
