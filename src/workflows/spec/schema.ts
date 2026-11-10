/**
 * Zod schemas of the run spec contract: the single source of truth for the
 * shape of a {@link RunSpec} and of the {@link RunRules} a host enforces.
 *
 * @remarks
 * The schemas describe structure only: types, required keys, enums, string
 * formats and sizes. Rules that compare fields with each other or with the
 * host's rules (path overlap, dependency cycles, caps, allowlists, human
 * approval before publication) belong to `validateRunSpec`.
 *
 * No schema has a default or a transform, so the input and output types are
 * the same and a validated spec is the document that was submitted.
 *
 * This module needs `zod` 4. Importing it registers the field descriptions in
 * zod's global registry and has no other effect.
 *
 * @packageDocumentation
 */
import { z } from "zod";
import type { ExternalAgentPermissionMode } from "../../agents/permissions/schema.js";
import { MAX_PORTABLE_PATH_LENGTH } from "../internal/portable-path.js";
import {
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowActorRole,
  type WorkflowMutationReservationPhase,
  type WorkflowPlan,
  type WorkflowPlanAgent,
  type WorkflowPlanInvariant,
  type WorkflowPlanLane,
  type WorkflowPlanWave,
} from "../orchestration/contracts.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Hard size limits of a run spec, enforced by the schemas whatever the host
 * rules say.
 *
 * @remarks
 * A host can only tighten them through {@link RunRules}. They keep
 * validation cheap: an oversized array is rejected before its items are read.
 *
 * @experimental
 */
export const RUN_SPEC_LIMITS = Object.freeze({
  /** Most lanes in one spec. */
  maxLanes: 1_000,
  /** Most entries in one lane's `dependsOn`. */
  maxDependsOn: 256,
  /** Most entries in one lane's `allowedPaths`. */
  maxAllowedPaths: 64,
  /** Most tool names for one agent. */
  maxTools: 64,
  /** Most environment variable names in one spec. */
  maxEnvNames: 64,
  /** Most QA commands in one spec. */
  maxQaCommands: 32,
  /** Most arguments of one QA command, counting the executable. */
  maxCommandArgs: 64,
  /** Longest QA command argument, in UTF-16 code units. */
  maxCommandArgLength: 1_024,
  /** Most review-and-change rounds for one lane. */
  maxChangeRounds: 10,
  /** Largest concurrency a spec or a rule set can name. */
  maxConcurrency: 256,
  /** Largest budget a spec or a rule set can name, in USD. */
  maxBudgetUsd: 1_000_000,
  /** Longest lane title, in UTF-16 code units. */
  maxTitleLength: 256,
  /** Longest path, in UTF-16 code units; the portable path limit. */
  maxPathLength: MAX_PORTABLE_PATH_LENGTH,
  /** Most extension keys on one object. */
  maxExtensions: 16,
  /** Most entries in one allowlist or denylist of a rule set. */
  maxRuleListEntries: 1_024,
  /** Most rule set ids recorded for one merged rule. */
  maxRuleOrigins: 64,
});

/**
 * Bounds of the raw input, checked before the schema reads it.
 *
 * @remarks
 * They are the limits of the JSON guard that copies and freezes the input
 * (depth, number of values, length of any string or key). A value above them
 * is rejected without being parsed.
 *
 * @experimental
 */
export const RUN_SPEC_INPUT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 250_000,
  maxStringLength: 65_536,
});

/**
 * Bounds of the value under one extension key.
 *
 * @remarks
 * Extension values are opaque JSON: only these bounds are checked.
 *
 * @experimental
 */
export const RUN_SPEC_EXTENSION_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 256,
  maxStringLength: 4_096,
});

/**
 * File name patterns that usually hold secrets, for
 * `RunRules.deniedPathPatterns`.
 *
 * @remarks
 * A pattern is compared with each segment of a path, ignoring case; `*`
 * stands for any run of characters inside the segment. The list is a starting
 * point for a host's rule set, not a rule the library applies by itself.
 *
 * @experimental
 */
export const DEFAULT_DENIED_PATH_PATTERNS: readonly string[] = Object.freeze([
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".ssh",
  ".gnupg",
  ".aws",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git",
  ".git-credentials",
  "credentials.json",
  "secrets.*",
  ".envrc",
  ".env-*",
  ".env_*",
  "*.env",
  "env.local",
  "secret",
  "secrets",
  "secret.*",
  "credentials",
  "credentials.*",
  "application_default_credentials.json",
  "service-account*.json",
  ".kube",
  "kubeconfig",
  ".docker",
  ".dockercfg",
  ".pgpass",
  ".my.cnf",
  ".htpasswd",
  ".vault-token",
  ".gitconfig",
  ".yarnrc",
  ".yarnrc.yml",
  ".s3cfg",
  ".boto",
  ".azure",
  ".terraformrc",
  "terraform.rc",
  "*.tfstate",
  "*.tfstate.*",
  "*.tfvars",
  "*.ppk",
  "*.p8",
  "*.keytab",
  "*.kdbx",
]);

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

// The identifier patterns repeat the record and opaque grammars of
// `internal/identifiers.ts`, which does not export its expressions. They must
// stay equal: a spec id is copied unchanged into plans and start requests.
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;
// A merge target is a git ref name (`git check-ref-format`): the opaque
// grammar without `:` (a refspec separator), and no `..`, `//`, segment
// starting with `.`, segment ending in `.lock`, or trailing `/` or `.`.
const TARGET_REF_PATTERN =
  /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock(?:\/|$))(?!.*[./]$)[A-Za-z0-9][A-Za-z0-9._+/-]{0,255}$/u;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,255}$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const EXTENSION_KEY_PATTERN = /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PATH_PATTERN_PATTERN = /^[A-Za-z0-9._*~@+-]{1,128}$/u;
const NO_CONTROL_CHARACTERS_PATTERN = /^\P{Cc}+$/u;

const recordId = () => z.string().min(1).max(256).regex(RECORD_ID_PATTERN);
const opaqueId = () => z.string().min(1).max(256).regex(OPAQUE_ID_PATTERN);
const providerId = () => z.string().min(1).max(64).regex(PROVIDER_ID_PATTERN);
const modelId = () => z.string().min(1).max(256).regex(MODEL_PATTERN);
const toolName = () => z.string().min(1).max(128).regex(TOOL_NAME_PATTERN);
const envName = () => z.string().min(1).max(128).regex(ENV_NAME_PATTERN);
const relativePath = () => z.string().min(1).max(RUN_SPEC_LIMITS.maxPathLength);
const commandArgument = () =>
  z
    .string()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxCommandArgLength)
    .regex(NO_CONTROL_CHARACTERS_PATTERN);

const ROLES = {
  architect: "architect",
  worker: "worker",
  integration: "integration",
  critic: "critic",
} as const satisfies { [Role in WorkflowActorRole]: Role };

const PERMISSION_MODES = {
  "read-only": "read-only",
  ask: "ask",
  "workspace-write": "workspace-write",
  "full-access": "full-access",
} as const satisfies { [Mode in ExternalAgentPermissionMode]: Mode };

// `full-access` is left out on purpose: a rule set cannot allow the mode
// that removes every restriction, so no merge or override can enable it.
const HOST_PERMISSION_MODES = {
  "read-only": "read-only",
  ask: "ask",
  "workspace-write": "workspace-write",
} as const satisfies {
  [Mode in Exclude<ExternalAgentPermissionMode, "full-access">]: Mode;
};

const PUBLISH_KINDS = {
  none: "none",
  commit: "commit",
  integration: "integration",
} as const satisfies {
  [Kind in WorkflowMutationReservationPhase | "none"]: Kind;
};

/**
 * Role of a lane: the existing plan roles, unchanged.
 *
 * @experimental
 */
export const RunSpecRoleSchema = z.enum(ROLES).meta({
  id: "RunSpecRole",
  description:
    "Role of the lane's agent, as in a workflow plan: architect, worker, integration or critic.",
});

/**
 * Permission mode an agent asks for: the external agent modes, unchanged.
 *
 * @experimental
 */
export const RunSpecPermissionModeSchema = z.enum(PERMISSION_MODES).meta({
  id: "RunSpecPermissionMode",
  description:
    "Permission mode of the agent, from most to least restrictive: read-only, ask, workspace-write, full-access. Host rules never allow full-access.",
});

/**
 * Extension data: keys `x-<vendor>`, values opaque JSON.
 *
 * @remarks
 * The schema checks the keys only. The size of each value is checked against
 * {@link RUN_SPEC_EXTENSION_LIMITS} by `validateRunSpec`; the library never
 * reads the content.
 *
 * @experimental
 */
export const RunSpecExtensionsSchema = z
  .record(z.string().min(3).max(64).regex(EXTENSION_KEY_PATTERN), z.unknown())
  .meta({
    id: "RunSpecExtensions",
    description:
      "Vendor data the library does not interpret. Keys are x-<vendor> in lower case; each value is JSON of bounded size.",
  });

// ---------------------------------------------------------------------------
// Run spec, version 1
// ---------------------------------------------------------------------------

/**
 * The agent that runs a lane.
 *
 * @experimental
 */
export const RunSpecAgentSchema = z
  .strictObject({
    providerId: providerId().describe(
      "Id of the agent provider or driver registered on the host, for example claude-code or codex.",
    ),
    model: modelId().describe(
      "Model id passed to the provider. It must be in the host's model allowlist.",
    ),
    mode: RunSpecPermissionModeSchema.describe(
      "Permission mode the agent runs under. It must be in the host's permission mode allowlist.",
    ),
    allowNetwork: z
      .boolean()
      .optional()
      .describe(
        "Whether the agent may reach the network. Absent means false. True is accepted only when the host rules allow network access.",
      ),
    tools: z
      .array(toolName())
      .max(RUN_SPEC_LIMITS.maxTools)
      .describe(
        "Names of the tools the agent may use. Each must be in the host's tool allowlist; an empty list means no optional tool.",
      ),
  })
  .meta({
    id: "RunSpecAgent",
    description:
      "Agent of a lane: provider, model, permission mode, network access and tools. It carries no credential and no host handle.",
  });

/**
 * How a lane's result is reviewed.
 *
 * @experimental
 */
export const RunSpecReviewSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("none").describe("The lane's result is not reviewed."),
    }),
    z.strictObject({
      kind: z
        .literal("agent")
        .describe("A second agent reviews the lane's result."),
      providerId: providerId().describe(
        "Id of the provider that runs the reviewer.",
      ),
      model: modelId().describe(
        "Model id of the reviewer. It must be in the host's model allowlist.",
      ),
      maxChangeRounds: z
        .int()
        .min(0)
        .max(RUN_SPEC_LIMITS.maxChangeRounds)
        .describe(
          "Most rounds in which the lane's agent changes its work after a review. 0 means one review and no change.",
        ),
    }),
  ])
  .meta({
    id: "RunSpecReview",
    description:
      "Review policy of a lane: none, or a reviewer agent that runs read-only without network and a bound on change rounds.",
  });

/**
 * Steps a lane runs, in order: optional tests first, the implementation, and
 * the review rounds.
 *
 * @experimental
 */
export const RunSpecStepsPolicySchema = z
  .strictObject({
    testsFirst: z
      .boolean()
      .describe(
        "Whether the lane's agent writes failing tests in a separate run before the implementation.",
      ),
    review: RunSpecReviewSchema.describe("How the lane's result is reviewed."),
  })
  .meta({
    id: "RunSpecStepsPolicy",
    description:
      "Step policy of a lane. It fixes the largest number of agent runs the lane can use.",
  });

/**
 * One lane: a unit of work with its own agent, paths and dependencies.
 *
 * @experimental
 */
export const RunSpecLaneSchema = z
  .strictObject({
    taskId: recordId().describe(
      "Identifier of the lane, unique in the spec. It becomes the task id of the plan lane.",
    ),
    title: z
      .string()
      .min(1)
      .max(RUN_SPEC_LIMITS.maxTitleLength)
      .describe("Short description of the lane's work, for people."),
    role: RunSpecRoleSchema.describe("Role the lane's agent plays."),
    dependsOn: z
      .array(recordId())
      .max(RUN_SPEC_LIMITS.maxDependsOn)
      .describe(
        "Task ids of the lanes that must finish before this lane starts. Each must name another lane of the spec; the graph must have no cycle.",
      ),
    allowedPaths: z
      .array(relativePath())
      .max(RUN_SPEC_LIMITS.maxAllowedPaths)
      .describe(
        "Paths the lane may change, relative to projectRoot, in canonical form with forward slashes. Each covers the entry and everything below it. No two lanes may name overlapping paths.",
      ),
    agent: RunSpecAgentSchema.describe("Agent that runs the lane."),
    steps: RunSpecStepsPolicySchema.describe("Steps the lane runs."),
    extensions: RunSpecExtensionsSchema.optional().describe(
      "Vendor data for this lane.",
    ),
  })
  .meta({
    id: "RunSpecLane",
    description:
      "A unit of work owned by one agent, with the paths it may change and the lanes it waits for.",
  });

/**
 * A QA command a host runs before it publishes anything.
 *
 * @experimental
 */
export const RunSpecQaCommandSchema = z
  .strictObject({
    id: recordId().describe("Identifier of the command, unique in the spec."),
    command: z
      .array(commandArgument())
      .min(1)
      .max(RUN_SPEC_LIMITS.maxCommandArgs)
      .describe(
        "Executable and arguments, one string each. It is not a shell line. The whole list must equal an entry of the host's QA command allowlist.",
      ),
  })
  .meta({
    id: "RunSpecQaCommand",
    description:
      "A check the host runs in the project root after the lanes finish, such as a test or lint command.",
  });

/**
 * What the run publishes once QA passes.
 *
 * @experimental
 */
export const RunSpecPublishSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z
        .literal(PUBLISH_KINDS.none)
        .describe("Nothing is committed; changes stay in the workspaces."),
    }),
    z.strictObject({
      kind: z
        .literal(PUBLISH_KINDS.commit)
        .describe("Each lane's accepted change is committed."),
      hitl: z
        .boolean()
        .describe(
          "Whether a person approves before each commit. It must be true.",
        ),
    }),
    z.strictObject({
      kind: z
        .literal(PUBLISH_KINDS.integration)
        .describe("Changes are committed and then merged into the target ref."),
      hitl: z
        .boolean()
        .describe(
          "Whether a person approves before each commit and before the merge. It must be true.",
        ),
      targetRef: z
        .string()
        .min(1)
        .max(256)
        .regex(TARGET_REF_PATTERN)
        .describe(
          "Git ref the commits are merged into, for example refs/heads/main. It must be a valid ref name: no '..', ':', '//', segment starting with '.', or trailing '/' or '.'.",
        ),
    }),
  ])
  .meta({
    id: "RunSpecPublish",
    description:
      "Publication of the run: none, commit, or commit followed by a merge into a target ref. Commit and merge need human approval.",
  });

/**
 * Gates between the lanes' work and its publication.
 *
 * @experimental
 */
export const RunSpecGatesSchema = z
  .strictObject({
    qa: z
      .array(RunSpecQaCommandSchema)
      .max(RUN_SPEC_LIMITS.maxQaCommands)
      .describe(
        "Commands that must all succeed before anything is published, in order.",
      ),
    publish: RunSpecPublishSchema.describe(
      "What the run publishes and whether a person approves it.",
    ),
  })
  .meta({
    id: "RunSpecGates",
    description: "QA commands and the publication policy of the run.",
  });

/**
 * Budget of a run.
 *
 * @experimental
 */
export const RunSpecBudgetSchema = z
  .strictObject({
    maxUsd: z
      .number()
      .positive()
      .max(RUN_SPEC_LIMITS.maxBudgetUsd)
      .describe(
        "Most the whole run may cost, in USD. The host stops starting agent runs when the metered cost reaches it.",
      ),
  })
  .meta({
    id: "RunSpecBudget",
    description: "Spending limit of the run.",
  });

/**
 * Version 1 of the run spec.
 *
 * @experimental
 */
export const RunSpecV1Schema = z
  .strictObject({
    specVersion: z
      .literal(1)
      .describe("Version of the run spec contract. This schema is version 1."),
    workflowId: opaqueId().describe(
      "Id of the registered workflow that executes the spec.",
    ),
    workflowVersion: opaqueId().describe(
      "Version of the registered workflow that executes the spec.",
    ),
    projectRoot: relativePath().describe(
      "Directory the lanes work in, relative to the workspace root the host binds, in canonical form with forward slashes. Use . for the workspace root itself. Absolute paths are rejected.",
    ),
    budget: RunSpecBudgetSchema.describe("Spending limit of the run."),
    maxConcurrency: z
      .int()
      .min(1)
      .max(RUN_SPEC_LIMITS.maxConcurrency)
      .describe("Most lanes that run at the same time."),
    lanes: z
      .array(RunSpecLaneSchema)
      .min(1)
      .max(RUN_SPEC_LIMITS.maxLanes)
      .describe("Lanes of the run. Their order breaks ties inside a wave."),
    gates: RunSpecGatesSchema.describe("QA commands and publication policy."),
    env: z
      .array(envName())
      .max(RUN_SPEC_LIMITS.maxEnvNames)
      .describe(
        "Names of the environment variables the agents may read. Names only: a spec never carries a value. Each must be in the host's allowlist.",
      ),
    extensions: RunSpecExtensionsSchema.optional().describe(
      "Vendor data for the whole run.",
    ),
  })
  .meta({
    id: "RunSpecV1",
    description:
      "A run submitted as data: the workflow, the project root, the budget, the lanes with their agents and paths, and the gates.",
  });

/**
 * Every supported version of the run spec, discriminated by `specVersion`.
 *
 * @remarks
 * Only version 1 exists. A new version is a new member of this union, so
 * code that switches on `specVersion` is checked for exhaustiveness.
 *
 * @experimental
 */
export const RunSpecSchema = z
  .discriminatedUnion("specVersion", [RunSpecV1Schema])
  .meta({
    title: "RunSpec",
    description:
      "A run of a lanes workflow, submitted as data. Rules that compare fields with each other or with host rules are checked by validateRunSpec, not by this schema.",
  });

// ---------------------------------------------------------------------------
// Run rules
// ---------------------------------------------------------------------------

/**
 * Names of the rules a rule set holds, used to record where each effective
 * value of a merged rule set came from.
 *
 * @experimental
 */
export const RUN_RULE_KEYS = [
  "maxBudgetUsd",
  "maxConcurrency",
  "maxLanes",
  "maxStringLength",
  "maxArrayLength",
  "maxChangeRounds",
  "maxAgentRuns",
  "allowedProviderIds",
  "allowedModels",
  "allowedPermissionModes",
  "allowNetwork",
  "allowedTools",
  "allowedEnvNames",
  "deniedPathPatterns",
  "allowedQaCommands",
  "requireQa",
  "allowedPublishKinds",
] as const;

const ruleSetId = () =>
  recordId().describe("Name of the rule set, for example base or team-ci.");

const ruleList = <Item extends z.ZodType>(item: Item) =>
  z.array(item).max(RUN_SPEC_LIMITS.maxRuleListEntries);

const RULE_FIELDS = {
  maxBudgetUsd: z
    .number()
    .positive()
    .max(RUN_SPEC_LIMITS.maxBudgetUsd)
    .describe("Largest budget a spec may declare, in USD."),
  maxConcurrency: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxConcurrency)
    .describe("Largest concurrency a spec may declare."),
  maxLanes: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxLanes)
    .describe("Most lanes a spec may have."),
  maxStringLength: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxPathLength)
    .describe(
      "Longest string a spec may hold outside extensions, in UTF-16 code units.",
    ),
  maxArrayLength: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxDependsOn)
    .describe("Longest array a spec may hold, other than lanes."),
  maxChangeRounds: z
    .int()
    .min(0)
    .max(RUN_SPEC_LIMITS.maxChangeRounds)
    .describe("Most change rounds a lane's review may declare."),
  maxAgentRuns: z
    .int()
    .min(1)
    .max(1_000_000)
    .describe(
      "Most agent runs the whole spec may need in the worst case, summed over its lanes.",
    ),
  allowedProviderIds: ruleList(providerId()).describe(
    "Provider ids a lane or a reviewer may name. Compared exactly.",
  ),
  allowedModels: ruleList(modelId()).describe(
    "Model ids a lane or a reviewer may name. Compared exactly, case included.",
  ),
  allowedPermissionModes: z
    .array(
      z
        .enum(HOST_PERMISSION_MODES)
        .describe("A permission mode other than full-access."),
    )
    .max(3)
    .describe(
      "Permission modes a lane's agent may ask for. full-access cannot be listed.",
    ),
  allowNetwork: z
    .boolean()
    .describe(
      "Whether a lane's agent may ask for network access. False rejects every lane that sets allowNetwork to true.",
    ),
  allowedTools: ruleList(toolName()).describe(
    "Tool names an agent may list. Compared exactly.",
  ),
  allowedEnvNames: ruleList(envName()).describe(
    "Environment variable names a spec may list. Compared exactly.",
  ),
  deniedPathPatterns: ruleList(z.string().regex(PATH_PATTERN_PATTERN)).describe(
    "File name patterns no path may contain. A pattern is compared with each path segment, ignoring case; * stands for any run of characters inside a segment.",
  ),
  allowedQaCommands: ruleList(
    z.array(commandArgument()).min(1).max(RUN_SPEC_LIMITS.maxCommandArgs),
  ).describe(
    "QA commands a spec may declare, each as the full list of executable and arguments. A command is allowed only when it equals one entry.",
  ),
  requireQa: z
    .boolean()
    .describe(
      "Whether a spec that publishes must declare at least one QA command.",
    ),
  allowedPublishKinds: z
    .array(z.enum(PUBLISH_KINDS).describe("A publication kind."))
    .max(3)
    .describe("Publication kinds a spec may ask for."),
} as const satisfies { [Key in (typeof RUN_RULE_KEYS)[number]]: z.ZodType };

/**
 * A complete rule set: what a host enforces on every spec it accepts.
 *
 * @remarks
 * Every rule is required, so a missing rule can never mean "allowed". Human
 * approval before a commit or a merge, unique lane ids, an acyclic dependency
 * graph, paths inside the project and non-overlapping lanes are not listed:
 * they always apply.
 *
 * @experimental
 */
export const RunRulesSchema = z
  .strictObject({
    id: ruleSetId(),
    ...RULE_FIELDS,
    origins: z
      .partialRecord(
        z.enum(RUN_RULE_KEYS),
        z.array(recordId()).min(1).max(RUN_SPEC_LIMITS.maxRuleOrigins),
      )
      .optional()
      .describe(
        "For a merged rule set: the ids of the rule sets that decided each effective value. Written by mergeRunRules; absent means every value comes from this rule set.",
      ),
  })
  .meta({
    id: "RunRules",
    description:
      "Limits and allowlists a host enforces on a run spec. Missing permission is never implied.",
  });

/**
 * A partial rule set that tightens a complete one.
 *
 * @remarks
 * A rule that is absent leaves the base value unchanged. See
 * {@link mergeRunRules}.
 *
 * @experimental
 */
export const RunRulesOverrideSchema = z
  .strictObject({
    id: ruleSetId(),
    ...z.strictObject(RULE_FIELDS).partial().shape,
  })
  .meta({
    id: "RunRulesOverride",
    description:
      "Rules a host layers over a base rule set. Each can only make the result more restrictive.",
  });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A run spec of any supported version, after validation.
 *
 * @experimental
 */
export type RunSpec = z.infer<typeof RunSpecSchema>;
/**
 * A run spec as submitted; the same as {@link RunSpec} because no field has a
 * default.
 *
 * @experimental
 */
export type RunSpecInput = z.input<typeof RunSpecSchema>;
/**
 * Version 1 of the run spec.
 *
 * @experimental
 */
export type RunSpecV1 = z.infer<typeof RunSpecV1Schema>;
/**
 * One lane of a run spec.
 *
 * @experimental
 */
export type RunSpecLane = z.infer<typeof RunSpecLaneSchema>;
/**
 * The agent of a lane.
 *
 * @experimental
 */
export type RunSpecAgent = z.infer<typeof RunSpecAgentSchema>;
/**
 * The review policy of a lane.
 *
 * @experimental
 */
export type RunSpecReview = z.infer<typeof RunSpecReviewSchema>;
/**
 * The step policy of a lane.
 *
 * @experimental
 */
export type RunSpecStepsPolicy = z.infer<typeof RunSpecStepsPolicySchema>;
/**
 * The gates of a run spec.
 *
 * @experimental
 */
export type RunSpecGates = z.infer<typeof RunSpecGatesSchema>;
/**
 * One QA command of a run spec.
 *
 * @experimental
 */
export type RunSpecQaCommand = z.infer<typeof RunSpecQaCommandSchema>;
/**
 * The publication policy of a run spec.
 *
 * @experimental
 */
export type RunSpecPublish = z.infer<typeof RunSpecPublishSchema>;
/**
 * The budget of a run spec.
 *
 * @experimental
 */
export type RunSpecBudget = z.infer<typeof RunSpecBudgetSchema>;
/**
 * Extension data of a run spec or a lane.
 *
 * @experimental
 */
export type RunSpecExtensions = z.infer<typeof RunSpecExtensionsSchema>;
/**
 * Role of a lane; the same union as `WorkflowActorRole`.
 *
 * @experimental
 */
export type RunSpecRole = z.infer<typeof RunSpecRoleSchema>;
/**
 * Permission mode of an agent; the same union as
 * `ExternalAgentPermissionMode`.
 *
 * @experimental
 */
export type RunSpecPermissionMode = z.infer<typeof RunSpecPermissionModeSchema>;
/**
 * A complete rule set.
 *
 * @experimental
 */
export type RunRules = z.infer<typeof RunRulesSchema>;
/**
 * A partial rule set layered over a complete one.
 *
 * @experimental
 */
export type RunRulesOverride = z.infer<typeof RunRulesOverrideSchema>;
/**
 * Name of one rule of a rule set.
 *
 * @experimental
 */
export type RunRuleKey = (typeof RUN_RULE_KEYS)[number];

/**
 * The part of a `WorkflowPlan` a run spec determines.
 *
 * @remarks
 * The host adds the execution id, the plan revision, the base revision, the
 * objective, the status and the creation time; see
 * {@link runSpecWorkflowPlan}.
 *
 * @experimental
 */
export type RunSpecTopology = Pick<
  WorkflowPlan,
  "agents" | "lanes" | "waves" | "invariants" | "reservedPaths"
>;

/**
 * Host values that complete a {@link RunSpecTopology} into a `WorkflowPlan`.
 *
 * @experimental
 */
export type RunSpecPlanBinding = Pick<
  WorkflowPlan,
  "executionId" | "baseRevision" | "objective" | "createdAt"
> &
  Partial<Pick<WorkflowPlan, "planRevision" | "status">>;

/**
 * Result of {@link layerRunSpecLanes}.
 *
 * @experimental
 */
export type RunSpecLayering = {
  /** Waves in dependency order; the lanes of a wave keep their spec order. */
  waves: WorkflowPlanWave[];
  /**
   * Task ids of the lanes that could not be placed, in spec order: lanes on a
   * dependency cycle, lanes that wait for one, lanes with an unknown
   * dependency and repeated task ids.
   */
  unresolved: string[];
};

// ---------------------------------------------------------------------------
// Pure helpers shared by the rule families and the planner
// ---------------------------------------------------------------------------

/**
 * Placeholder host values for validating a topology without a host.
 *
 * @remarks
 * `validateRunSpec` and `resolveRunPlan` read no clock and know no execution,
 * so they complete a topology with these fixed values before they call the
 * existing plan validator. A real plan uses the host's values.
 *
 * @experimental
 */
export const RUN_SPEC_DRY_RUN_BINDING: Readonly<RunSpecPlanBinding> =
  Object.freeze({
    executionId: "run-spec-dry-run",
    baseRevision: "0",
    objective: "Run spec dry run",
    createdAt: 0,
    planRevision: 1,
    status: "draft",
  });

/**
 * Merges a base rule set with host overrides; the most restrictive value of
 * each rule wins.
 *
 * @remarks
 * Overrides apply in order. For each rule an override names:
 *
 * - numeric caps: the smaller value;
 * - allowlists: the entries present in both lists, in the base order;
 * - `deniedPathPatterns`: the entries of both lists, base first;
 * - `allowNetwork`: true only when both are true;
 * - `requireQa`: true when either is true.
 *
 * The result keeps the base `id` and has `origins` for every rule: the ids of
 * the rule sets that decided its value. A cap or a flag names the one rule
 * set that holds the effective value (the earlier one on a tie); a list names
 * every rule set that changed it, after the origin of the base value. The
 * inputs are not modified, and an override can never widen the result.
 *
 * @param base - Complete rule set to start from.
 * @param overrides - Partial rule sets, applied in order.
 * @returns A new complete rule set.
 * @experimental
 */
export function mergeRunRules(
  base: RunRules,
  ...overrides: readonly RunRulesOverride[]
): RunRules {
  const origins = {} as Record<RunRuleKey, string[]>;
  for (const key of RUN_RULE_KEYS) {
    origins[key] = [...(base.origins?.[key] ?? [base.id])];
  }
  const merged: RunRules = {
    ...base,
    allowedProviderIds: [...base.allowedProviderIds],
    allowedModels: [...base.allowedModels],
    allowedPermissionModes: [...base.allowedPermissionModes],
    allowedTools: [...base.allowedTools],
    allowedEnvNames: [...base.allowedEnvNames],
    deniedPathPatterns: [...base.deniedPathPatterns],
    allowedQaCommands: base.allowedQaCommands.map((command) => [...command]),
    allowedPublishKinds: [...base.allowedPublishKinds],
    origins,
  };
  const changed = (key: RunRuleKey, id: string): void => {
    if (!origins[key].includes(id)) origins[key].push(id);
  };

  for (const override of overrides) {
    for (const key of CAP_KEYS) {
      const next = override[key];
      if (next !== undefined && next < merged[key]) {
        merged[key] = next;
        origins[key] = [override.id];
      }
    }
    if (override.allowNetwork === false && merged.allowNetwork) {
      merged.allowNetwork = false;
      origins.allowNetwork = [override.id];
    }
    if (override.requireQa === true && !merged.requireQa) {
      merged.requireQa = true;
      origins.requireQa = [override.id];
    }

    const narrow = <Item>(
      key: RunRuleKey,
      current: Item[],
      allowed: readonly Item[] | undefined,
      keyOf: (item: Item) => string,
    ): Item[] => {
      if (allowed === undefined) return current;
      const keep = new Set(allowed.map(keyOf));
      const kept = current.filter((item) => keep.has(keyOf(item)));
      if (kept.length !== current.length) changed(key, override.id);
      return kept;
    };
    merged.allowedProviderIds = narrow(
      "allowedProviderIds",
      merged.allowedProviderIds,
      override.allowedProviderIds,
      String,
    );
    merged.allowedModels = narrow(
      "allowedModels",
      merged.allowedModels,
      override.allowedModels,
      String,
    );
    merged.allowedPermissionModes = narrow(
      "allowedPermissionModes",
      merged.allowedPermissionModes,
      override.allowedPermissionModes,
      String,
    );
    merged.allowedTools = narrow(
      "allowedTools",
      merged.allowedTools,
      override.allowedTools,
      String,
    );
    merged.allowedEnvNames = narrow(
      "allowedEnvNames",
      merged.allowedEnvNames,
      override.allowedEnvNames,
      String,
    );
    merged.allowedPublishKinds = narrow(
      "allowedPublishKinds",
      merged.allowedPublishKinds,
      override.allowedPublishKinds,
      String,
    );
    merged.allowedQaCommands = narrow(
      "allowedQaCommands",
      merged.allowedQaCommands,
      override.allowedQaCommands,
      runSpecCommandKey,
    );

    if (override.deniedPathPatterns !== undefined) {
      const present = new Set(merged.deniedPathPatterns);
      for (const pattern of override.deniedPathPatterns) {
        if (present.has(pattern)) continue;
        present.add(pattern);
        merged.deniedPathPatterns.push(pattern);
        changed("deniedPathPatterns", override.id);
      }
    }
  }
  return merged;
}

const CAP_KEYS = [
  "maxBudgetUsd",
  "maxConcurrency",
  "maxLanes",
  "maxStringLength",
  "maxArrayLength",
  "maxChangeRounds",
  "maxAgentRuns",
] as const satisfies readonly RunRuleKey[];

/**
 * Identity of a QA command for comparison with an allowlist entry.
 *
 * @remarks
 * Two commands are the same when they have the same arguments in the same
 * order. The key is the JSON text of the list, so no argument can imitate a
 * separator.
 *
 * @param command - Executable and arguments.
 * @returns A string equal for equal commands only.
 * @experimental
 */
export function runSpecCommandKey(command: readonly string[]): string {
  return JSON.stringify(command);
}

/**
 * Joins a lane path to the project root, giving the path relative to the
 * workspace root that plans and ownership claims use.
 *
 * @remarks
 * Both values must already be canonical portable paths, so the result is
 * canonical too. A project root of `.` leaves the path unchanged.
 *
 * @param projectRoot - Project root of the spec.
 * @param path - Path relative to the project root.
 * @returns The path relative to the workspace root.
 * @experimental
 */
export function runSpecWorkspacePath(
  projectRoot: string,
  path: string,
): string {
  return projectRoot === "." ? path : `${projectRoot}/${path}`;
}

/**
 * Largest number of agent runs a lane can use.
 *
 * @remarks
 * One implementation run, plus one run for tests when `testsFirst` is set,
 * plus, with a reviewer, one review and then one change run and one more
 * review per change round.
 *
 * @param steps - Step policy of the lane.
 * @returns The worst-case number of agent runs.
 * @experimental
 */
export function runSpecLaneMaxAgentRuns(steps: RunSpecStepsPolicy): number {
  const review =
    steps.review.kind === "agent" ? 1 + 2 * steps.review.maxChangeRounds : 0;
  return 1 + (steps.testsFirst ? 1 : 0) + review;
}

/**
 * Groups lanes into waves: a lane sits one wave after the latest of its
 * dependencies, so the lanes of a wave can run in parallel.
 *
 * @remarks
 * Kahn's algorithm, in time proportional to lanes plus dependencies (plus a
 * sort of each wave). Waves are named `wave-1`, `wave-2` and so on, and each
 * keeps the spec order, so the same lanes always give the same waves. The
 * function never throws: a lane it cannot place is listed in `unresolved`
 * with every lane that waits for it. A repeated dependency counts once.
 *
 * @param lanes - Lanes with their task id and dependencies.
 * @returns The waves and the lanes that could not be placed.
 * @experimental
 */
export function layerRunSpecLanes(
  lanes: readonly Pick<RunSpecLane, "taskId" | "dependsOn">[],
): RunSpecLayering {
  const indexById = new Map<string, number>();
  for (const [index, lane] of lanes.entries()) {
    if (!indexById.has(lane.taskId)) indexById.set(lane.taskId, index);
  }
  const pending = new Array<number>(lanes.length).fill(0);
  const dependents = lanes.map((): number[] => []);
  for (const [index, lane] of lanes.entries()) {
    // A repeated task id is never released: nothing decrements this count.
    if (indexById.get(lane.taskId) !== index) {
      pending[index] = 1;
      continue;
    }
    for (const dependency of new Set(lane.dependsOn)) {
      pending[index] = (pending[index] ?? 0) + 1;
      // An unknown dependency has no lane to release it, and a lane that
      // names itself releases itself only after it has run.
      const source = indexById.get(dependency);
      if (source !== undefined) dependents[source]?.push(index);
    }
  }

  const waves: WorkflowPlanWave[] = [];
  let frontier: number[] = [];
  for (let index = 0; index < lanes.length; index++) {
    if (pending[index] === 0) frontier.push(index);
  }
  while (frontier.length > 0) {
    waves.push({
      waveId: `wave-${waves.length + 1}`,
      taskIds: frontier.map((index) => (lanes[index] as RunSpecLane).taskId),
    });
    const next: number[] = [];
    for (const index of frontier) {
      for (const dependent of dependents[index] ?? []) {
        const left = (pending[dependent] ?? 0) - 1;
        pending[dependent] = left;
        if (left === 0) next.push(dependent);
      }
    }
    frontier = next.sort((left, right) => left - right);
  }

  const unresolved: string[] = [];
  for (const [index, lane] of lanes.entries()) {
    if ((pending[index] ?? 0) > 0) unresolved.push(lane.taskId);
  }
  return { waves, unresolved };
}

/**
 * Projects a run spec onto the plan concepts the bridge already has.
 *
 * @remarks
 * Field by field:
 *
 * - `agents`: one plan agent per role the lanes use, with the role name as
 *   `agentId`, no permission and no delegation. A plan agent is a policy, not
 *   a provider: the spec grants no permission, the host adds them.
 * - `lanes`: one plan lane per spec lane, with the same `taskId`, `role` and
 *   `dependsOn`; `agentId` is the role; each allowed path, joined to the
 *   project root with {@link runSpecWorkspacePath}, becomes an owned path
 *   with scope `subtree`; `mayCreateUnder` and `acceptance` are empty.
 * - `waves`: the waves passed in, normally from {@link layerRunSpecLanes}.
 * - `invariants`: the budget, and human approval when the spec publishes.
 * - `reservedPaths`: empty.
 *
 * The provider, model, permission mode, tools, steps, gates and budget have
 * no place in a plan; they reach the workflow through the start request.
 *
 * @param spec - A run spec that passed the shape check.
 * @param waves - Waves of the lanes.
 * @returns The plan fields the spec determines.
 * @experimental
 */
export function runSpecPlanTopology(
  spec: RunSpec,
  waves: readonly WorkflowPlanWave[],
): RunSpecTopology {
  const roles: WorkflowActorRole[] = [];
  for (const lane of spec.lanes) {
    if (!roles.includes(lane.role)) roles.push(lane.role);
  }
  const agents: WorkflowPlanAgent[] = roles.map((role) => ({
    agentId: role,
    policy: { role, permissions: [], canDelegate: false },
  }));
  const lanes: WorkflowPlanLane[] = spec.lanes.map((lane) => ({
    taskId: lane.taskId,
    agentId: lane.role,
    role: lane.role,
    ownedPaths: lane.allowedPaths.map((path) => ({
      path: runSpecWorkspacePath(spec.projectRoot, path),
      scope: "subtree",
    })),
    mayCreateUnder: [],
    dependsOn: [...lane.dependsOn],
    acceptance: [],
  }));
  const invariants: WorkflowPlanInvariant[] = [
    {
      invariantId: "run-spec.budget",
      description:
        "No agent run starts once the metered cost reaches the budget of the run spec.",
      appliesTo: "workflow",
      enforcedBy: "host",
    },
  ];
  if (spec.gates.publish.kind !== "none") {
    invariants.push({
      invariantId: "run-spec.human-approval",
      description:
        "A person approves before each commit and before the merge into the target ref.",
      appliesTo: "integration",
      enforcedBy: "host",
    });
  }
  return {
    agents,
    lanes,
    waves: waves.map((wave) => ({
      waveId: wave.waveId,
      taskIds: [...wave.taskIds],
    })),
    invariants,
    reservedPaths: [],
  };
}

/**
 * Completes a topology into a `WorkflowPlan` with the host's values.
 *
 * @remarks
 * `planRevision` defaults to 1 and `status` to `ready`. The function does not
 * validate: pass the result to `validateWorkflowPlan` or to `plan.put`.
 *
 * @param topology - Plan fields from {@link runSpecPlanTopology}.
 * @param binding - Execution id, base revision, objective and creation time.
 * @returns A workflow plan.
 * @experimental
 */
export function runSpecWorkflowPlan(
  topology: RunSpecTopology,
  binding: RunSpecPlanBinding,
): WorkflowPlan {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: binding.executionId,
    planRevision: binding.planRevision ?? 1,
    baseRevision: binding.baseRevision,
    objective: binding.objective,
    status: binding.status ?? "ready",
    createdAt: binding.createdAt,
    agents: topology.agents,
    lanes: topology.lanes,
    waves: topology.waves,
    invariants: topology.invariants,
    reservedPaths: topology.reservedPaths,
  };
}
