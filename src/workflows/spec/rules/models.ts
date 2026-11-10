import { type RunSpecIssue, runSpecIssue } from "../issues.js";
import {
  type RunRules,
  RunRulesSchema,
  type RunSpec,
  RunSpecAgentSchema,
  RunSpecV1Schema,
  runSpecWorkflowKey,
} from "../schema.js";

// Name grammars come from the schema, the single source of truth. A value that
// is listed in a rule set still has to match, so a rule set that lists
// `TOKEN=abc` or `Bash(rm -rf /)` cannot let it through.
const TOOL_NAME_SCHEMA = RunSpecAgentSchema.shape.tools.element;
const ENV_NAME_SCHEMA = RunSpecV1Schema.shape.env.element;
const MODEL_SCHEMA = RunSpecAgentSchema.shape.model;
const PROVIDER_SCHEMA = RunSpecAgentSchema.shape.providerId;
// Modes a rule set may allow: the schema leaves out `full-access`.
const HOST_MODE_SCHEMA = RunRulesSchema.shape.allowedPermissionModes.element;

/** Longest value copied into a message. */
const MAX_ECHO = 64;

/** Quotes a short, printable form of a spec value for a message. */
function echo(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  const head = text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}...` : text;
  return JSON.stringify(head);
}

/** Set of the strings of a rule list that are really strings. */
function allowSet(list: readonly unknown[] | undefined): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(list)) return set;
  for (const item of list) if (typeof item === "string") set.add(item);
  return set;
}

/**
 * Checks the models rules of a run spec whose shape is already valid and
 * appends one issue per violation.
 *
 * @remarks
 * Every comparison is exact: case, whitespace and encoding are never
 * normalized, so a lookalike never matches an allowlist entry. `full-access`
 * is rejected whatever the rule set lists, and the network stays off unless
 * the rule set is exactly `allowNetwork: true`. Provider ids, model ids,
 * tool names and `env` names must also match their grammar, and a message
 * never echoes an `env` entry. The workflow id and version must equal one
 * entry of `allowedWorkflows`; an empty list allows none.
 *
 * @param spec - The spec, already shape-checked.
 * @param rules - The host's rules.
 * @param issues - Receives the issues found.
 * @experimental
 */
export function checkModelRules(
  spec: RunSpec,
  rules: RunRules,
  issues: RunSpecIssue[],
): void {
  const providers = allowSet(rules.allowedProviderIds);
  const models = allowSet(rules.allowedModels);
  // Only entries that are valid host modes count, so an unknown mode listed
  // in a rule set cannot match a spec value of the same text.
  const modes = new Set<string>();
  for (const mode of allowSet(rules.allowedPermissionModes)) {
    if (HOST_MODE_SCHEMA.safeParse(mode).success) modes.add(mode);
  }
  const tools = allowSet(rules.allowedTools);
  const envNames = allowSet(rules.allowedEnvNames);
  const networkAllowed = (rules.allowNetwork as unknown) === true;

  checkWorkflow(spec, rules, issues);

  const checkProvider = (
    value: string,
    path: (string | number)[],
    who: string,
  ): void => {
    if (!providers.has(value) || !PROVIDER_SCHEMA.safeParse(value).success) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_PROVIDER_NOT_ALLOWED",
          path,
          `The ${who} provider ${echo(value)} is not in the allowed providers.`,
        ),
      );
    }
  };
  const checkModel = (
    value: string,
    path: (string | number)[],
    who: string,
  ): void => {
    if (!models.has(value) || !MODEL_SCHEMA.safeParse(value).success) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_MODEL_NOT_ALLOWED",
          path,
          `The ${who} model ${echo(value)} is not in the allowed models.`,
        ),
      );
    }
  };

  const toolValid = new Map<string, boolean>();
  spec.lanes.forEach((lane, index) => {
    const base = ["lanes", index];
    const agent = lane.agent;
    checkProvider(agent.providerId, [...base, "agent", "providerId"], "agent");
    checkModel(agent.model, [...base, "agent", "model"], "agent");

    if (!modes.has(agent.mode)) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
          [...base, "agent", "mode"],
          `The permission mode ${echo(agent.mode)} is not in the allowed permission modes.`,
        ),
      );
    }

    // Anything but a literal false counts as a request for the network.
    const wantsNetwork =
      agent.allowNetwork !== undefined &&
      (agent.allowNetwork as unknown) !== false;
    if (wantsNetwork && !networkAllowed) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_NETWORK_NOT_ALLOWED",
          [...base, "agent", "allowNetwork"],
          "The agent asks for network access and the rules do not allow it.",
        ),
      );
    }

    const seenTools = new Set<string>();
    agent.tools.forEach((tool, toolIndex) => {
      const path = [...base, "agent", "tools", toolIndex];
      let valid = toolValid.get(tool);
      if (valid === undefined) {
        valid = tools.has(tool) && TOOL_NAME_SCHEMA.safeParse(tool).success;
        toolValid.set(tool, valid);
      }
      if (!valid) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_TOOL_NOT_ALLOWED",
            path,
            `The tool ${echo(tool)} is not in the allowed tools.`,
          ),
        );
      }
      if (seenTools.has(tool)) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_TOOL_DUPLICATE",
            path,
            `The tool ${echo(tool)} is listed more than once for this agent.`,
          ),
        );
      } else {
        seenTools.add(tool);
      }
    });

    const review = lane.steps.review;
    if (review.kind === "agent") {
      const reviewBase = [...base, "steps", "review"];
      checkProvider(
        review.providerId,
        [...reviewBase, "providerId"],
        "reviewer",
      );
      checkModel(review.model, [...reviewBase, "model"], "reviewer");
    }
  });

  const envValid = new Map<string, boolean>();
  const seenEnv = new Set<string>();
  spec.env.forEach((name, index) => {
    const path = ["env", index];
    let valid = envValid.get(name);
    if (valid === undefined) {
      valid = envNames.has(name) && ENV_NAME_SCHEMA.safeParse(name).success;
      envValid.set(name, valid);
    }
    // The entry is never copied into a message: it may hold a secret.
    if (!valid) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_ENV_NAME_NOT_ALLOWED",
          path,
          "An env entry is not an allowed variable name.",
        ),
      );
    }
    if (seenEnv.has(name)) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_ENV_NAME_DUPLICATE",
          path,
          "An env name is listed more than once.",
        ),
      );
    } else {
      seenEnv.add(name);
    }
  });
}

/** Reports a workflow id and version that no `allowedWorkflows` entry names. */
function checkWorkflow(
  spec: RunSpec,
  rules: RunRules,
  issues: RunSpecIssue[],
): void {
  const entries = Array.isArray(rules.allowedWorkflows)
    ? rules.allowedWorkflows
    : [];
  const wanted = runSpecWorkflowKey(spec);
  if (entries.some((entry) => runSpecWorkflowKey(entry) === wanted)) return;
  const idListed = entries.some(
    (entry) => entry.workflowId === spec.workflowId,
  );
  issues.push(
    runSpecIssue(
      "RUN_SPEC_WORKFLOW_NOT_ALLOWED",
      [idListed ? "workflowVersion" : "workflowId"],
      idListed
        ? "The workflow version is not in the rule set's allowed workflows."
        : "The workflow is not in the rule set's allowed workflows.",
    ),
  );
}
