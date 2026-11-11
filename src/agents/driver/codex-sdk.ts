import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import type { Content } from "@google/genai";
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
import { safeCollectContents } from "../runtime/content-collector.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import {
  type CodexInputPart,
  summarizeHistoryForColdStart,
  userContentToCodexInput,
} from "./codex-input-mapper.js";
import {
  type CodexMcpLister,
  codexApprovalsReviewerOverrides,
  codexMcpDisableOverrides,
} from "./codex-mcp.js";
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
  assertModelOption,
  assertNoCodexConfigModelOverride,
  CODEX_MODEL_ENV,
  MODEL_ALIAS_DENYLIST,
  modelEnvRefusal,
} from "./model.js";
import {
  dependencyMissing,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
  networkUnenforceable,
  policyErrorEvent,
  unenforceablePathsRefusal,
  unsandboxedShellRefusal,
} from "./policy-errors.js";
import { codexTurnUsage } from "./run-summary.js";
import {
  agentWritableRoots,
  asRecord,
  candidateBaseDirectories,
  contextText,
  copyIfPresent,
  credentialEnv,
  describeMissingExecutable,
  executableCandidates,
  findExecutable,
  isSearchableExecutable,
  readCredentialEnv,
  removeUndefined,
  stringValue,
} from "./shared.js";
import {
  type StrictBinaryCheck,
  strictBinaryRefusal,
} from "./strict-binary.js";

/**
 * Ambient environment variables forwarded from `this.#env` into the Codex SDK's
 * replacement env (the SDK does not inherit `process.env`). Covers proxy/cert
 * egress configuration plus a custom shell `CODEX_HOME`.
 */
const CODEX_AMBIENT_PASSTHROUGH = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CODEX_HOME",
] as const;

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

type CodexSdkThreadOptions = {
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

type CodexSdkTurnOptions = {
  signal?: AbortSignal;
  outputSchema?: Record<string, unknown>;
};

type CodexSdkThreadEvent = Record<string, unknown>;

type CodexSdkInput = string | CodexInputPart[];

type CodexSdkThreadLike = {
  readonly id?: string | null;
  runStreamed(
    input: CodexSdkInput,
    options?: CodexSdkTurnOptions,
  ): Promise<{ events: AsyncGenerator<CodexSdkThreadEvent> }>;
};

type CodexSdkClientLike = {
  startThread(options?: CodexSdkThreadOptions): CodexSdkThreadLike;
  resumeThread(id: string, options?: CodexSdkThreadOptions): CodexSdkThreadLike;
};

type CodexSdkConstructor = new (
  options?: CodexSdkOptions,
) => CodexSdkClientLike;

type CodexSdkModuleLike = {
  Codex: CodexSdkConstructor;
};

/** Which Codex binary a run uses, and where the driver looked. */
export interface CodexBinaryResolution {
  /** The binary, or `undefined` when none was found. */
  path?: string;
  /** Every location tried, in order. */
  checked: string[];
  /**
   * Directories the binary needs on `PATH` (the `codex-path` or `path`
   * directory of an npm-installed Codex package). The SDK adds them only
   * when it finds the binary itself, so the driver adds them to the env of
   * the client and of the MCP listing.
   */
  pathDirs?: string[];
}

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
   * contain (any version other than 0.167.0, or one it cannot read) through
   * the SDK's own exec, **without the containment**. Without it such a run is
   * refused with `EXTERNAL_AGENT_DEPENDENCY_MISSING`.
   *
   * With it, a codex that exits, is aborted or closes stdin before it reads
   * the prompt can end the host process with an uncaught `EPIPE` from the
   * SDK. The driver logs one `CODEX_SDK_UNCONTAINED` warning per driver
   * instance. On 0.167.0 the option changes nothing: the contained exec is
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
 * copy of the SDK 0.167.0 exec path: such a run ends with
 * `CODEX_SDK_INPUT_NOT_DELIVERED` (or `CODEX_SDK_ERROR` for a non-zero exit of
 * codex's own). The copy is used only on the installed SDK versions it was
 * copied from (0.167.0, read at run time); another version, or a client
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
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when `strictBinaryResolution` is
   * set together with a prebuilt `sdk` client,
   * `EXTERNAL_AGENT_MODEL_OVERRIDE` when `config` sets or routes the model,
   * `EXTERNAL_AGENT_MODEL_INVALID` when `model` is not a model id, and
   * `EXTERNAL_AGENT_MODEL_REQUIRED` when `requireExplicitModel` is set and
   * `model` is absent.
   */
  constructor(config: CodexSdkDriverConfig = {}) {
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
        CODEX_MODEL_ENV,
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

    let completed = false;
    let failed = false;
    let terminalEvent: ExternalAgentEvent | undefined;
    let cleanup: () => Promise<void> = async () => {};
    try {
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
      const threadOptions = this.buildThreadOptions(request);
      const agentName = request.agent?.name ?? request.context?.agent?.name;
      const stateKey = agentName ? this.#threadStateKey(agentName) : undefined;
      // An explicit runtime session id wins over the id saved in state.
      const savedThreadId =
        stringValue(request.runtimeSession?.id) ??
        readSavedThreadId(request, stateKey);
      const contents = safeCollectContents(request.context);
      const lastContent = contents[contents.length - 1];

      let thread: CodexSdkThreadLike;
      let input: CodexSdkInput;

      if (savedThreadId) {
        assertThreadIdIsNotAFlag(savedThreadId);
        thread = sdk.resumeThread(savedThreadId, threadOptions);
        const mapping = mapLastContentOrFallback(lastContent, request);
        cleanup = mapping.cleanup;
        input = applyInstruction(request.instruction, mapping.input);
      } else if (contents.length > 1 && lastContent) {
        thread = sdk.startThread(threadOptions);
        const mapping = userContentToCodexInput(lastContent);
        cleanup = mapping.cleanup;
        const transcript = summarizeHistoryForColdStart(contents);
        input = applyInstruction(
          request.instruction,
          prependColdStartTranscript(mapping.input, transcript),
        );
      } else {
        thread = sdk.startThread(threadOptions);
        const mapping = mapLastContentOrFallback(lastContent, request);
        cleanup = mapping.cleanup;
        input = applyInstruction(request.instruction, mapping.input);
      }

      if (
        containment === "contained" &&
        !threadUsesExec(thread, (sdk as { exec?: unknown }).exec)
      ) {
        throw codexSdkUncontainable(installedCodexSdkVersion());
      }

      const { events } = await thread.runStreamed(input, {
        signal: resolveAbortSignal(request),
        outputSchema: this.#outputSchema,
      });

      // Track the thread id as soon as it is known so resumability survives a
      // mid-turn throw. The `thread.started` event carries it before the first
      // turn completes; we emit the `state_delta` immediately and
      // remember it so the post-loop read does not re-emit.
      let emittedThreadId: string | undefined;
      const emitThreadId = (threadId: string | undefined) => {
        if (!stateKey || !threadId) return undefined;
        if (threadId === savedThreadId || threadId === emittedThreadId) {
          return undefined;
        }
        emittedThreadId = threadId;
        const delta: ExternalAgentEvent = {
          type: "state_delta",
          stateDelta: { [stateKey]: threadId },
          timestamp: Date.now(),
        };
        return delta;
      };

      // One failure surfaces as a stream `error` followed by `turn.failed`.
      // Hold the stream error back until the next event: when it is the
      // `turn.failed` for the same failure, only that one error is emitted.
      let pendingStreamError: ExternalAgentEvent | undefined;
      stream: for await (const event of events) {
        const eventType = stringValue(event.type);
        if (eventType === "error") {
          if (pendingStreamError) {
            yield pendingStreamError;
          }
          pendingStreamError = this.normalizeEvent(event)[0];
          continue;
        }
        let normalizedEvent = event;
        if (pendingStreamError) {
          const held = pendingStreamError;
          pendingStreamError = undefined;
          if (eventType !== "turn.failed") {
            yield held;
          } else if (
            held.type === "error" &&
            !stringValue(asRecord(event.error).message)
          ) {
            // Keep the stream error's message when `turn.failed` has none.
            normalizedEvent = { ...event, error: { message: held.message } };
          }
        }
        if (eventType === "thread.started") {
          const delta = emitThreadId(threadStartedId(event));
          if (delta) {
            yield delta;
          }
          continue;
        }
        for (const normalized of this.normalizeEvent(normalizedEvent)) {
          if (normalized.type === "completed") {
            terminalEvent = normalized;
            break stream;
          }
          yield normalized;
        }
      }
      if (pendingStreamError) {
        yield pendingStreamError;
      }

      // Fallback: if `thread.started` was never observed (older event stream),
      // persist the id from the post-loop accessor.
      const postLoopDelta = emitThreadId(thread.id ?? undefined);
      if (postLoopDelta) {
        yield postLoopDelta;
      }

      if (terminalEvent) {
        completed = true;
        yield terminalEvent;
      }
    } catch (error) {
      failed = true;
      yield this.errorEvent(error, request);
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
    const env = this.buildEnv(request);
    const dirs = binary.pathDirs ?? [];
    if (dirs.length > 0) {
      const rest = (env.PATH ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0 && !dirs.includes(entry));
      env.PATH = [...dirs, ...rest].join(delimiter);
    }
    return env;
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
    const excluded = agentWritableRoots(request);
    const found = findExecutable(
      [
        this.#codexPathOverride,
        this.#env.CODEX_EXECUTABLE,
        this.#env.CODEX_CLI_PATH,
        readCredentialEnv(request, "CODEX_EXECUTABLE"),
        readCredentialEnv(request, "CODEX_CLI_PATH"),
      ],
      codexBinaryCandidates({ env: this.#env, excluded }),
    );
    if (found.path) {
      return found;
    }
    const { checked } = found;

    // The npm-installed binary, found the way @openai/codex-sdk finds it.
    for (const base of candidateBaseDirectories()) {
      const found = findNpmCodexBinary(base, checked, excluded);
      if (found) {
        return { ...found, checked };
      }
    }

    return { checked };
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
    const env: Record<string, string> = {};
    copyIfPresent(this.#env, env, "PATH");
    copyIfPresent(this.#env, env, "HOME");
    copyIfPresent(this.#env, env, "USER");
    copyIfPresent(this.#env, env, "SHELL");
    copyIfPresent(this.#env, env, "XDG_CONFIG_HOME");

    // The SDK builds a *replacement* env (it does not inherit `process.env`
    // when `env` is supplied), so ambient proxy/cert vars must be forwarded
    // explicitly or egress through a corporate proxy / custom CA breaks. A
    // custom shell `CODEX_HOME` is also carried through here so it is not lost
    // when it is not delivered via a structured credential. When a
    // credential supplies one of these keys it overrides the ambient value
    // through `credentialEnv` below.
    for (const key of CODEX_AMBIENT_PASSTHROUGH) {
      copyIfPresent(this.#env, env, key);
    }

    return Object.assign(env, credentialEnv(request));
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
    const type = stringValue(event.type);
    const timestamp = Date.now();

    if (type === "turn.completed") {
      // Codex reports token usage per turn; it does not report the model.
      const usage = codexTurnUsage(event.usage);
      return [
        {
          type: "completed",
          exitCode: 0,
          ...(usage ? { usage } : {}),
          timestamp,
        },
      ];
    }

    if (type === "turn.failed") {
      const error = asRecord(event.error);
      const message = stringValue(error.message) ?? "Codex turn failed";
      const { recoverable, code } = classifyRecoverable({
        message,
        fallbackCode: "CODEX_TURN_FAILED",
      });
      return [
        {
          type: "error",
          message,
          code,
          recoverable,
          timestamp,
        },
        { type: "completed", exitCode: 1, timestamp },
      ];
    }

    if (type === "error") {
      const message = stringValue(event.message) ?? "Codex SDK error";
      const { recoverable, code } = classifyRecoverable({
        message,
        fallbackCode: "CODEX_SDK_STREAM_ERROR",
      });
      return [
        {
          type: "error",
          message,
          code,
          recoverable,
          timestamp,
        },
      ];
    }

    if (type === "item.started" || type === "item.updated") {
      return normalizeProgressItem(asRecord(event.item), timestamp);
    }

    if (type !== "item.completed") {
      return [];
    }

    return normalizeCompletedItem(asRecord(event.item), timestamp);
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

function normalizeProgressItem(
  item: Record<string, unknown>,
  timestamp: number,
): ExternalAgentEvent[] {
  const itemType = stringValue(item.type);
  // Same value as the builtin tool_call `callId`, so the first progress event
  // can set the start time of the tool span.
  const itemId = stringValue(item.id);
  const idMetadata = itemId ? { itemId } : {};

  if (itemType === "command_execution") {
    const command = stringValue(item.command);
    const status = stringValue(item.status);
    return command
      ? [
          {
            type: "output",
            content: `Codex command ${status ?? "running"}: ${command}`,
            partial: true,
            turnComplete: false,
            metadata: {
              itemType,
              ...idMetadata,
              status,
              command,
              exitCode: item.exit_code,
              title: `Codex: command_execution ${status ?? "running"}`,
            },
            timestamp,
          },
        ]
      : [];
  }

  if (itemType === "mcp_tool_call") {
    const toolName = stringValue(item.tool) ?? "mcp_tool_call";
    const status = stringValue(item.status) ?? "running";
    return [
      {
        type: "output",
        content: `Codex MCP tool ${status}: ${toolName}`,
        partial: true,
        turnComplete: false,
        metadata: {
          itemType,
          ...idMetadata,
          toolName,
          status: item.status,
          title: `Codex: ${toolName} ${status}`,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "web_search") {
    const query = stringValue(item.query);
    return query
      ? [
          {
            type: "output",
            content: `Codex web search: ${query}`,
            partial: true,
            turnComplete: false,
            metadata: {
              itemType,
              ...idMetadata,
              query,
              title: "Codex: web_search",
            },
            timestamp,
          },
        ]
      : [];
  }

  return [];
}

function normalizeCompletedItem(
  item: Record<string, unknown>,
  timestamp: number,
): ExternalAgentEvent[] {
  const itemType = stringValue(item.type);

  if (itemType === "agent_message") {
    const text = stringValue(item.text);
    return text
      ? [{ type: "output", content: text, stream: "stdout", timestamp }]
      : [];
  }

  if (itemType === "error") {
    const message = stringValue(item.message) ?? "Codex item error";
    const { recoverable, code } = classifyRecoverable({
      message,
      fallbackCode: "CODEX_ITEM_ERROR",
    });
    return [
      {
        type: "error",
        message,
        code,
        recoverable,
        timestamp,
      },
    ];
  }

  if (itemType === "mcp_tool_call") {
    const toolName = stringValue(item.tool) ?? "mcp_tool_call";
    const status = stringValue(item.status) ?? "completed";
    return [
      {
        type: "tool_call",
        name: toolName,
        input: {
          server: item.server,
          arguments: item.arguments,
          status: item.status,
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          title: `Codex: ${toolName} call`,
        },
        timestamp,
      },
      {
        type: "tool_result",
        name: toolName,
        result: {
          server: item.server,
          status: item.status,
          result: item.result,
          error: item.error,
        },
        callId: stringValue(item.id),
        error: stringValue(item.error),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          title: `Codex: ${toolName} ${status}`,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "command_execution") {
    const command = stringValue(item.command);
    const status = stringValue(item.status) ?? "completed";
    return [
      {
        type: "tool_call",
        name: "command_execution",
        input: {
          command: item.command,
          status: item.status,
          exitCode: item.exit_code,
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          command,
          title: "Codex: command_execution call",
        },
        timestamp,
      },
      {
        type: "tool_result",
        name: "command_execution",
        result: {
          command: item.command,
          status: item.status,
          exitCode: item.exit_code,
          ...(typeof item.aggregated_output === "string"
            ? { output: item.aggregated_output }
            : {}),
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          command,
          exitCode: item.exit_code,
          title: `Codex: command_execution ${status}`,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "file_change") {
    // A patch the agent applied with its own tools.
    const status = stringValue(item.status) ?? "completed";
    const callId = stringValue(item.id);
    const metadata = { itemType, builtin: true, status: item.status };
    return [
      {
        type: "tool_call",
        name: "file_change",
        input: { changes: item.changes },
        callId,
        metadata: { ...metadata, title: "Codex: file_change call" },
        timestamp,
      },
      {
        type: "tool_result",
        name: "file_change",
        result: { changes: item.changes, status: item.status },
        callId,
        ...(status === "failed" ? { error: "Codex patch failed" } : {}),
        metadata: { ...metadata, title: `Codex: file_change ${status}` },
        timestamp,
      },
    ];
  }

  if (itemType === "web_search") {
    const callId = stringValue(item.id);
    const metadata = { itemType, builtin: true };
    return [
      {
        type: "tool_call",
        name: "web_search",
        input: { query: item.query },
        callId,
        metadata: { ...metadata, title: "Codex: web_search call" },
        timestamp,
      },
      {
        type: "tool_result",
        name: "web_search",
        result: { query: item.query },
        callId,
        metadata: { ...metadata, title: "Codex: web_search completed" },
        timestamp,
      },
    ];
  }

  return [];
}

/**
 * Extract the thread id from a `thread.started` event. The SDK shape is
 * `ThreadStartedEvent { type: "thread.started", thread_id }`.
 */
function threadStartedId(event: CodexSdkThreadEvent): string | undefined {
  return stringValue(event.thread_id) ?? stringValue(asRecord(event.thread).id);
}

function mapLastContentOrFallback(
  lastContent: Content | undefined,
  request: ExternalAgentRunRequest,
): { input: CodexSdkInput; cleanup: () => Promise<void> } {
  if (lastContent) {
    return userContentToCodexInput(lastContent);
  }
  // No content collected — fall back to the legacy text extractor so synthetic
  // contexts (e.g. unit tests with just `userContent: {...}`) keep working.
  const text = contextText(request.context) ?? "";
  return { input: text, cleanup: async () => {} };
}

function applyInstruction(
  instruction: string | undefined,
  input: CodexSdkInput,
): CodexSdkInput {
  if (!instruction || instruction.length === 0) {
    return input;
  }
  if (typeof input === "string") {
    return input.length > 0 ? `${instruction}\n\n${input}` : instruction;
  }
  return [{ type: "text", text: instruction }, ...input];
}

function prependColdStartTranscript(
  input: CodexSdkInput,
  transcript: string,
): CodexSdkInput {
  if (!transcript || transcript.length === 0) {
    return input;
  }
  if (typeof input === "string") {
    return input.length > 0 ? `${transcript}\n\n${input}` : transcript;
  }
  // Array input. If the first part is text, fold the transcript into it;
  // otherwise (e.g. starts with an image), insert a synthetic text part.
  const first = input[0];
  if (first && first.type === "text") {
    return [
      { type: "text", text: `${transcript}\n\n${first.text}` },
      ...input.slice(1),
    ];
  }
  return [{ type: "text", text: transcript }, ...input];
}

/**
 * Refuses a thread id that starts with `-`.
 *
 * The SDK passes the id as its own argv entry after `resume`, and
 * `codex exec resume` reads an entry that starts with `-` as an option, so
 * an id such as `--dangerously-bypass-approvals-and-sandbox` would change
 * the run's policy instead of naming a thread. The id can come from session
 * state, which other agents and tools may write.
 *
 * @param threadId - The id the run would resume.
 * @throws ExternalAgentPolicyError with `EXTERNAL_AGENT_OPTION_UNSUPPORTED`.
 */
function assertThreadIdIsNotAFlag(threadId: string): void {
  if (threadId.startsWith("-")) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      "CodexSdkDriver: the thread id to resume starts with '-', which codex exec resume would read as an option rather than a thread id. Codex thread ids never start with '-'; check runtimeSession.id and the thread id saved in session state.",
    );
  }
}

function readSavedThreadId(
  request: ExternalAgentRunRequest,
  stateKey: string | undefined,
): string | undefined {
  if (!stateKey) return undefined;
  const session = (
    request.context as { session?: { state?: unknown } } | undefined
  )?.session;
  const state = session?.state;
  if (!state || typeof state !== "object") {
    return undefined;
  }
  const value = (state as Record<string, unknown>)[stateKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function codexBinaryCandidates({
  env,
  excluded,
}: {
  env: Record<string, string | undefined>;
  excluded: readonly string[];
}): string[] {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  return executableCandidates({
    executable,
    env,
    excluded,
    packagePaths: (base) =>
      platformCodexPackages().map(([platformPackage, targetTriple]) =>
        join(
          base,
          "node_modules",
          "@openai",
          platformPackage,
          "vendor",
          targetTriple,
          "codex",
          executable,
        ),
      ),
  });
}

/**
 * The binary of the `@openai/codex` npm package, resolved like
 * `@openai/codex-sdk` 0.167.0 does: `@openai/codex/package.json` from the
 * SDK's own location (or from `base`), then the platform package from
 * there, then `vendor/<triple>/bin/codex` (with `codex-package.json` next to
 * it, and `codex-path` for `PATH`) or the older `vendor/<triple>/codex/codex`
 * (with `path`).
 */
function findNpmCodexBinary(
  base: string,
  checked: string[],
  excluded: readonly string[],
): { path: string; pathDirs: string[] } | undefined {
  const [platform] = platformCodexPackages();
  if (!platform) {
    return undefined;
  }
  const [platformPackage, targetTriple] = platform;
  const sdkEntry = join(
    base,
    "node_modules",
    "@openai",
    "codex-sdk",
    "dist",
    "index.js",
  );
  // createRequire only needs a file name to resolve from; it may not exist.
  const starts = existsSync(sdkEntry)
    ? [sdkEntry, join(base, "index.js")]
    : [join(base, "index.js")];
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  for (const start of starts) {
    let vendorRoot: string;
    try {
      const codexPackage = createRequire(start).resolve(
        "@openai/codex/package.json",
      );
      const platformJson = createRequire(codexPackage).resolve(
        `@openai/${platformPackage}/package.json`,
      );
      vendorRoot = join(dirname(platformJson), "vendor");
    } catch {
      continue;
    }
    const root = join(vendorRoot, targetTriple);
    // The package resolution can follow a symlink into the workspace.
    if (!isSearchableExecutable(root, excluded)) {
      continue;
    }
    const current = join(root, "bin", executable);
    checked.push(current);
    if (isFile(current) && isFile(join(root, "codex-package.json"))) {
      return {
        path: current,
        pathDirs: existingDirs(join(root, "codex-path")),
      };
    }
    const legacy = join(root, "codex", executable);
    checked.push(legacy);
    if (isFile(legacy)) {
      return { path: legacy, pathDirs: existingDirs(join(root, "path")) };
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function existingDirs(...paths: string[]): string[] {
  return paths.filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
}

function platformCodexPackages(): Array<[string, string]> {
  switch (`${process.platform}:${process.arch}`) {
    case "darwin:arm64":
      return [["codex-darwin-arm64", "aarch64-apple-darwin"]];
    case "darwin:x64":
      return [["codex-darwin-x64", "x86_64-apple-darwin"]];
    case "linux:arm64":
      return [["codex-linux-arm64", "aarch64-unknown-linux-musl"]];
    case "linux:x64":
      return [["codex-linux-x64", "x86_64-unknown-linux-musl"]];
    case "win32:arm64":
      return [["codex-win32-arm64", "aarch64-pc-windows-msvc"]];
    case "win32:x64":
      return [["codex-win32-x64", "x86_64-pc-windows-msvc"]];
    default:
      return [];
  }
}
