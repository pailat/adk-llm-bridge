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
 * This module needs `zod` 4. Field descriptions and schema ids live in a
 * registry of this module, not in zod's global registry, so importing it has
 * no side effect.
 *
 * @packageDocumentation
 */
import { z } from "zod";
import type { ExternalAgentPermissionMode } from "../../agents/permissions/schema.js";
import { freezeJson } from "../internal/immutable-json.js";
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
import { boundedCopy } from "./copy.js";
import { runSpecRegistry } from "./registry.js";

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
  /**
   * Most allowed paths over all lanes. The plan validator compares every pair
   * of path claims, so this bounds its cost.
   */
  maxTotalAllowedPaths: 1_024,
  /** Most tool names for one agent. */
  maxTools: 64,
  /** Most environment variable names in one spec. */
  maxEnvNames: 64,
  /** Most QA commands in one spec. */
  maxQaCommands: 32,
  /** Most arguments of one QA command, counting the executable. */
  maxCommandArgs: 64,
  /** Longest QA command argument, in Unicode code points. */
  maxCommandArgLength: 1_024,
  /** Most review-and-change rounds for one lane. */
  maxChangeRounds: 10,
  /** Largest concurrency a spec or a rule set can name. */
  maxConcurrency: 256,
  /** Largest budget a spec or a rule set can name, in USD. */
  maxBudgetUsd: 1_000_000,
  /** Longest lane title, in Unicode code points. */
  maxTitleLength: 256,
  /**
   * Longest path, in Unicode code points. The paths rules also apply the
   * portable path limit, the same number in UTF-16 code units.
   */
  maxPathLength: MAX_PORTABLE_PATH_LENGTH,
  /** Most segments in one path, so matching paths against patterns stays bounded. */
  maxPathSegments: 64,
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
/**
 * Number of Unicode code points in a string, the unit JSON Schema
 * `maxLength` counts. A lone surrogate counts as one.
 */
function codePointLength(value: string): number {
  let count = value.length;
  for (let index = 0; index < value.length - 1; index += 1) {
    const high = value.charCodeAt(index);
    if (high < 0xd800 || high > 0xdbff) continue;
    const low = value.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      count -= 1;
      index += 1;
    }
  }
  return count;
}

/**
 * A non-empty string of at most `max` code points, with `maxLength` in its
 * JSON Schema.
 *
 * @remarks
 * Free text can hold astral characters such as emoji, which are two UTF-16
 * code units but one code point. zod 4 releases differ on which of the two
 * `.max()` counts, so the bound is checked here, in code points, and both
 * the shape parser and the JSON Schema agree on every zod 4.
 */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .superRefine((value, context) => {
      if (codePointLength(value) > max) {
        context.addIssue({
          code: "too_big",
          origin: "string",
          maximum: max,
          inclusive: true,
          input: value,
        });
      }
    })
    .register(runSpecRegistry, { maxLength: max });

const relativePath = () => text(RUN_SPEC_LIMITS.maxPathLength);
const commandArgument = () =>
  text(RUN_SPEC_LIMITS.maxCommandArgLength).regex(
    NO_CONTROL_CHARACTERS_PATTERN,
  );

const targetRefName = () =>
  z.string().min(1).max(256).regex(TARGET_REF_PATTERN);

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
export const RunSpecRoleSchema = z
  .enum(ROLES)
  .clone()
  .register(runSpecRegistry, {
    id: "RunSpecRole",
    description:
      "Role of the lane's agent, as in a workflow plan: architect, worker, integration or critic.",
  });

/**
 * Permission mode an agent asks for: the external agent modes, unchanged.
 *
 * @experimental
 */
export const RunSpecPermissionModeSchema = z
  .enum(PERMISSION_MODES)
  .clone()
  .register(runSpecRegistry, {
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
  .clone()
  .register(runSpecRegistry, {
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
    providerId: providerId().clone().register(runSpecRegistry, {
      description:
        "Id of the agent provider or driver registered on the host, for example claude-code or codex.",
    }),
    model: modelId().clone().register(runSpecRegistry, {
      description:
        "Model id passed to the provider. It must be in the host's model allowlist.",
    }),
    mode: RunSpecPermissionModeSchema.clone().register(runSpecRegistry, {
      description:
        "Permission mode the agent runs under. It must be in the host's permission mode allowlist.",
    }),
    allowNetwork: z.boolean().optional().clone().register(runSpecRegistry, {
      description:
        "Whether the agent may reach the network. Absent means false. True is accepted only when the host rules allow network access.",
    }),
    tools: z
      .array(toolName())
      .max(RUN_SPEC_LIMITS.maxTools)
      .clone()
      .register(runSpecRegistry, {
        description:
          "Names of the tools the agent may use. Each must be in the host's tool allowlist; an empty list means no optional tool.",
      }),
  })
  .clone()
  .register(runSpecRegistry, {
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
      kind: z.literal("none").clone().register(runSpecRegistry, {
        description: "The lane's result is not reviewed.",
      }),
    }),
    z.strictObject({
      kind: z.literal("agent").clone().register(runSpecRegistry, {
        description: "A second agent reviews the lane's result.",
      }),
      providerId: providerId().clone().register(runSpecRegistry, {
        description: "Id of the provider that runs the reviewer.",
      }),
      model: modelId().clone().register(runSpecRegistry, {
        description:
          "Model id of the reviewer. It must be in the host's model allowlist.",
      }),
      maxChangeRounds: z
        .int()
        .min(0)
        .max(RUN_SPEC_LIMITS.maxChangeRounds)
        .clone()
        .register(runSpecRegistry, {
          description:
            "Most rounds in which the lane's agent changes its work after a review. 0 means one review and no change.",
        }),
    }),
  ])
  .clone()
  .register(runSpecRegistry, {
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
    testsFirst: z.boolean().clone().register(runSpecRegistry, {
      description:
        "Whether the lane's agent writes failing tests in a separate run before the implementation.",
    }),
    review: RunSpecReviewSchema.clone().register(runSpecRegistry, {
      description: "How the lane's result is reviewed.",
    }),
  })
  .clone()
  .register(runSpecRegistry, {
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
    taskId: recordId().clone().register(runSpecRegistry, {
      description:
        "Identifier of the lane, unique in the spec. It becomes the task id of the plan lane.",
    }),
    title: text(RUN_SPEC_LIMITS.maxTitleLength)
      .clone()
      .register(runSpecRegistry, {
        description: "Short description of the lane's work, for people.",
      }),
    role: RunSpecRoleSchema.clone().register(runSpecRegistry, {
      description: "Role the lane's agent plays.",
    }),
    dependsOn: z
      .array(recordId())
      .max(RUN_SPEC_LIMITS.maxDependsOn)
      .clone()
      .register(runSpecRegistry, {
        description:
          "Task ids of the lanes that must finish before this lane starts. Each must name another lane of the spec; the graph must have no cycle.",
      }),
    allowedPaths: z
      .array(relativePath())
      .max(RUN_SPEC_LIMITS.maxAllowedPaths)
      .clone()
      .register(runSpecRegistry, {
        description:
          "Paths the lane may change, relative to projectRoot, in canonical form with forward slashes. Each covers the entry and everything below it. No two lanes may name overlapping paths.",
      }),
    agent: RunSpecAgentSchema.clone().register(runSpecRegistry, {
      description: "Agent that runs the lane.",
    }),
    steps: RunSpecStepsPolicySchema.clone().register(runSpecRegistry, {
      description: "Steps the lane runs.",
    }),
    extensions: RunSpecExtensionsSchema.optional()
      .clone()
      .register(runSpecRegistry, { description: "Vendor data for this lane." }),
  })
  .clone()
  .register(runSpecRegistry, {
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
    id: recordId().clone().register(runSpecRegistry, {
      description: "Identifier of the command, unique in the spec.",
    }),
    command: z
      .array(commandArgument())
      .min(1)
      .max(RUN_SPEC_LIMITS.maxCommandArgs)
      .clone()
      .register(runSpecRegistry, {
        description:
          "Executable and arguments, one string each. It is not a shell line. The whole list must equal an entry of the host's QA command allowlist.",
      }),
  })
  .clone()
  .register(runSpecRegistry, {
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
      kind: z.literal(PUBLISH_KINDS.none).clone().register(runSpecRegistry, {
        description: "Nothing is committed; changes stay in the workspaces.",
      }),
    }),
    z.strictObject({
      kind: z.literal(PUBLISH_KINDS.commit).clone().register(runSpecRegistry, {
        description: "Each lane's accepted change is committed.",
      }),
      hitl: z.boolean().clone().register(runSpecRegistry, {
        description:
          "Whether a person approves before each commit. It must be true.",
      }),
    }),
    z.strictObject({
      kind: z
        .literal(PUBLISH_KINDS.integration)
        .clone()
        .register(runSpecRegistry, {
          description:
            "Changes are committed and then merged into the target ref.",
        }),
      hitl: z.boolean().clone().register(runSpecRegistry, {
        description:
          "Whether a person approves before each commit and before the merge. It must be true.",
      }),
      targetRef: targetRefName().clone().register(runSpecRegistry, {
        description:
          "Git ref the commits are merged into, for example refs/heads/main. It must be a valid ref name: no '..', ':', '//', segment starting with '.', or trailing '/' or '.'.",
      }),
    }),
  ])
  .clone()
  .register(runSpecRegistry, {
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
      .clone()
      .register(runSpecRegistry, {
        description:
          "Commands that must all succeed before anything is published, in order.",
      }),
    publish: RunSpecPublishSchema.clone().register(runSpecRegistry, {
      description: "What the run publishes and whether a person approves it.",
    }),
  })
  .clone()
  .register(runSpecRegistry, {
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
      .clone()
      .register(runSpecRegistry, {
        description:
          "Most the whole run may cost, in USD. The host stops starting agent runs when the metered cost reaches it.",
      }),
  })
  .clone()
  .register(runSpecRegistry, {
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
    specVersion: z.literal(1).clone().register(runSpecRegistry, {
      description:
        "Version of the run spec contract. This schema is version 1.",
    }),
    workflowId: opaqueId().clone().register(runSpecRegistry, {
      description: "Id of the registered workflow that executes the spec.",
    }),
    workflowVersion: opaqueId().clone().register(runSpecRegistry, {
      description: "Version of the registered workflow that executes the spec.",
    }),
    projectRoot: relativePath().clone().register(runSpecRegistry, {
      description:
        "Directory the lanes work in, relative to the workspace root the host binds, in canonical form with forward slashes. Use . for the workspace root itself. Absolute paths are rejected.",
    }),
    budget: RunSpecBudgetSchema.clone().register(runSpecRegistry, {
      description: "Spending limit of the run.",
    }),
    maxConcurrency: z
      .int()
      .min(1)
      .max(RUN_SPEC_LIMITS.maxConcurrency)
      .clone()
      .register(runSpecRegistry, {
        description: "Most lanes that run at the same time.",
      }),
    lanes: z
      .array(RunSpecLaneSchema)
      .min(1)
      .max(RUN_SPEC_LIMITS.maxLanes)
      .clone()
      .register(runSpecRegistry, {
        description: "Lanes of the run. Their order breaks ties inside a wave.",
      }),
    gates: RunSpecGatesSchema.clone().register(runSpecRegistry, {
      description: "QA commands and publication policy.",
    }),
    env: z
      .array(envName())
      .max(RUN_SPEC_LIMITS.maxEnvNames)
      .clone()
      .register(runSpecRegistry, {
        description:
          "Names of the environment variables the agents may read. Names only: a spec never carries a value. Each must be in the host's allowlist.",
      }),
    extensions: RunSpecExtensionsSchema.optional()
      .clone()
      .register(runSpecRegistry, {
        description: "Vendor data for the whole run.",
      }),
  })
  .clone()
  .register(runSpecRegistry, {
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
  .clone()
  .register(runSpecRegistry, {
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
  "allowedWorkflows",
  "allowedTargetRefs",
] as const;

const ruleSetId = () =>
  recordId().clone().register(runSpecRegistry, {
    description: "Name of the rule set, for example base or team-ci.",
  });

const ruleList = <Item extends z.ZodType>(item: Item) =>
  z.array(item).max(RUN_SPEC_LIMITS.maxRuleListEntries);

const RULE_FIELDS = {
  maxBudgetUsd: z
    .number()
    .positive()
    .max(RUN_SPEC_LIMITS.maxBudgetUsd)
    .clone()
    .register(runSpecRegistry, {
      description: "Largest budget a spec may declare, in USD.",
    }),
  maxConcurrency: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxConcurrency)
    .clone()
    .register(runSpecRegistry, {
      description: "Largest concurrency a spec may declare.",
    }),
  maxLanes: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxLanes)
    .clone()
    .register(runSpecRegistry, { description: "Most lanes a spec may have." }),
  maxStringLength: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxPathLength)
    .clone()
    .register(runSpecRegistry, {
      description:
        "Longest string a spec may hold outside extensions, in UTF-16 code units.",
    }),
  maxArrayLength: z
    .int()
    .min(1)
    .max(RUN_SPEC_LIMITS.maxDependsOn)
    .clone()
    .register(runSpecRegistry, {
      description: "Longest array a spec may hold, other than lanes.",
    }),
  maxChangeRounds: z
    .int()
    .min(0)
    .max(RUN_SPEC_LIMITS.maxChangeRounds)
    .clone()
    .register(runSpecRegistry, {
      description: "Most change rounds a lane's review may declare.",
    }),
  maxAgentRuns: z
    .int()
    .min(1)
    .max(1_000_000)
    .clone()
    .register(runSpecRegistry, {
      description:
        "Most agent runs the whole spec may need in the worst case, summed over its lanes.",
    }),
  allowedProviderIds: ruleList(providerId()).clone().register(runSpecRegistry, {
    description:
      "Provider ids a lane or a reviewer may name. Compared exactly.",
  }),
  allowedModels: ruleList(modelId()).clone().register(runSpecRegistry, {
    description:
      "Model ids a lane or a reviewer may name. Compared exactly, case included.",
  }),
  allowedPermissionModes: z
    .array(
      z.enum(HOST_PERMISSION_MODES).clone().register(runSpecRegistry, {
        description: "A permission mode other than full-access.",
      }),
    )
    .max(3)
    .clone()
    .register(runSpecRegistry, {
      description:
        "Permission modes a lane's agent may ask for. full-access cannot be listed.",
    }),
  allowNetwork: z.boolean().clone().register(runSpecRegistry, {
    description:
      "Whether a lane's agent may ask for network access. False rejects every lane that sets allowNetwork to true.",
  }),
  allowedTools: ruleList(toolName()).clone().register(runSpecRegistry, {
    description: "Tool names an agent may list. Compared exactly.",
  }),
  allowedEnvNames: ruleList(envName()).clone().register(runSpecRegistry, {
    description:
      "Environment variable names a spec may list. Compared exactly.",
  }),
  deniedPathPatterns: ruleList(z.string().regex(PATH_PATTERN_PATTERN))
    .clone()
    .register(runSpecRegistry, {
      description:
        "File name patterns no path may contain. A pattern is compared with each path segment, ignoring case; * stands for any run of characters inside a segment.",
    }),
  allowedQaCommands: ruleList(
    z.array(commandArgument()).min(1).max(RUN_SPEC_LIMITS.maxCommandArgs),
  )
    .clone()
    .register(runSpecRegistry, {
      description:
        "QA commands a spec may declare, each as the full list of executable and arguments. A command is allowed only when it equals one entry.",
    }),
  requireQa: z.boolean().clone().register(runSpecRegistry, {
    description:
      "Whether a spec that publishes must declare at least one QA command.",
  }),
  allowedPublishKinds: z
    .array(
      z
        .enum(PUBLISH_KINDS)
        .clone()
        .register(runSpecRegistry, { description: "A publication kind." }),
    )
    .max(3)
    .clone()
    .register(runSpecRegistry, {
      description: "Publication kinds a spec may ask for.",
    }),
  allowedWorkflows: ruleList(
    z
      .strictObject({
        workflowId: opaqueId().clone().register(runSpecRegistry, {
          description: "Id of a registered workflow.",
        }),
        workflowVersion: opaqueId().clone().register(runSpecRegistry, {
          description: "Version of that workflow.",
        }),
      })
      .clone()
      .register(runSpecRegistry, {
        description: "A workflow id and version, compared exactly.",
      }),
  )
    .clone()
    .register(runSpecRegistry, {
      description:
        "Workflows a spec may run, each as an id and a version. A spec is allowed only when both equal one entry. An empty list allows none.",
    }),
  allowedTargetRefs: ruleList(
    targetRefName().clone().register(runSpecRegistry, {
      description: "A git ref name, compared exactly.",
    }),
  )
    .clone()
    .register(runSpecRegistry, {
      description:
        "Git refs an integration may merge into, for example refs/heads/main. A ref is allowed only when it equals one entry. An empty list allows no integration.",
    }),
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
      .clone()
      .register(runSpecRegistry, {
        description:
          "For a merged rule set: the ids of the rule sets that decided each effective value. Written by mergeRunRules; absent means every value comes from this rule set.",
      }),
  })
  .clone()
  .register(runSpecRegistry, {
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
  .clone()
  .register(runSpecRegistry, {
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

/** The JSON guard callback for a rule set; {@link readRuleSet} catches it. */
function failRuleSet(message: string): never {
  throw new TypeError(message);
}

/**
 * Reads a host rule set once and checks the copy against its schema.
 *
 * @remarks
 * The rule set is copied as plain JSON first: own enumerable keys only, each
 * getter called once, within `RUN_SPEC_INPUT_LIMITS`. Callers use the
 * returned copy, never the input, so a getter cannot answer differently after
 * the check and a key inherited from a prototype is not a rule.
 *
 * @param schema - {@link RunRulesSchema} or {@link RunRulesOverrideSchema}.
 * @param value - The host's value.
 * @returns The checked copy, or `undefined` when the value is not plain JSON,
 * does not match the schema, or throws while it is read.
 * @internal
 */
export function readRuleSet<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> | undefined {
  try {
    const copy = freezeJson(
      boundedCopy(value, RUN_SPEC_INPUT_LIMITS, failRuleSet),
      RUN_SPEC_INPUT_LIMITS,
      failRuleSet,
    );
    const parsed = schema.safeParse(copy);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merges a base rule set with host overrides; the most restrictive value of
 * each rule wins.
 *
 * @remarks
 * Overrides apply in order. For each rule an override names:
 *
 * - numeric caps: the smaller value;
 * - allowlists (including `allowedWorkflows`, compared by id and version, and
 *   `allowedTargetRefs`): the entries present in both lists, in the base
 *   order;
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
 * @returns A new complete rule set that matches {@link RunRulesSchema}.
 * @throws `TypeError` when `base` does not match {@link RunRulesSchema}, an
 * override does not match {@link RunRulesOverrideSchema}, a rule would
 * record more than `RUN_SPEC_LIMITS.maxRuleOrigins` origins, or the merged
 * `deniedPathPatterns` would have more than
 * `RUN_SPEC_LIMITS.maxRuleListEntries` entries.
 * @experimental
 */
export function mergeRunRules(
  base: RunRules,
  ...overrides: readonly RunRulesOverride[]
): RunRules {
  const checkedBase = readRuleSet(RunRulesSchema, base);
  if (checkedBase === undefined) {
    throw new TypeError(
      "mergeRunRules: the base does not match RunRulesSchema.",
    );
  }
  const checkedOverrides = overrides.map((override, index) => {
    const checked = readRuleSet(RunRulesOverrideSchema, override);
    if (checked === undefined) {
      throw new TypeError(
        `mergeRunRules: override ${index} does not match RunRulesOverrideSchema.`,
      );
    }
    return checked;
  });
  const merged = mergeCheckedRunRules(checkedBase, checkedOverrides);
  if (merged.deniedPathPatterns.length > RUN_SPEC_LIMITS.maxRuleListEntries) {
    throw new TypeError(
      `mergeRunRules: deniedPathPatterns would exceed ${RUN_SPEC_LIMITS.maxRuleListEntries} entries.`,
    );
  }
  for (const key of RUN_RULE_KEYS) {
    if ((merged.origins?.[key]?.length ?? 0) > RUN_SPEC_LIMITS.maxRuleOrigins) {
      throw new TypeError(
        `mergeRunRules: ${key} would record more than ${RUN_SPEC_LIMITS.maxRuleOrigins} origins.`,
      );
    }
  }
  return merged;
}

/** {@link mergeRunRules} on inputs that already match their schemas. */
function mergeCheckedRunRules(
  base: RunRules,
  overrides: readonly RunRulesOverride[],
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
    allowedWorkflows: base.allowedWorkflows.map((entry) => ({ ...entry })),
    allowedTargetRefs: [...base.allowedTargetRefs],
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
    merged.allowedWorkflows = narrow(
      "allowedWorkflows",
      merged.allowedWorkflows,
      override.allowedWorkflows,
      runSpecWorkflowKey,
    );
    merged.allowedTargetRefs = narrow(
      "allowedTargetRefs",
      merged.allowedTargetRefs,
      override.allowedTargetRefs,
      String,
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
 * Identity of a workflow for comparison with an `allowedWorkflows` entry.
 *
 * @remarks
 * The JSON text of the id and the version, so neither can imitate a
 * separator.
 *
 * @param workflow - Workflow id and version.
 * @returns A string equal for equal id and version pairs only.
 * @internal
 */
export function runSpecWorkflowKey(workflow: {
  readonly workflowId: string;
  readonly workflowVersion: string;
}): string {
  return JSON.stringify([workflow.workflowId, workflow.workflowVersion]);
}

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
 * - `invariants`: the budget, the denied paths, and human approval when the
 *   spec publishes.
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
    {
      invariantId: "run-spec.denied-paths",
      description:
        "No write lands on a path with a segment that matches a denied path pattern of the rule set or is shaped like a Windows short name, even inside an owned subtree.",
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
