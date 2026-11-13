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
const MCP_PROVIDER_SCHEMA = RunSpecAgentSchema.shape.mcp.unwrap().element;
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
 * tool names, MCP provider ids and `env` names must also match their
 * grammar, and a message never echoes an `env` entry. An MCP provider id must
 * be in `allowedMcpProviders` (an empty list allows none) and unique in its
 * agent ignoring case. The workflow id and version must equal one
 * entry of `allowedWorkflows`; an empty list allows none. A model must also
 * be in the `allowedModelsByRole` list of its role when the rule set has one
 * (a lane agent by the lane's role, an agent reviewer as `reviewer`).
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
  const mcpProviders = allowSet(rules.allowedMcpProviders);
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
  const byRole = rules.allowedModelsByRole;
  const checkModel = (
    value: string,
    path: (string | number)[],
    who: string,
    role: string,
  ): void => {
    if (!models.has(value) || !MODEL_SCHEMA.safeParse(value).success) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_MODEL_NOT_ALLOWED",
          path,
          `The ${who} model ${echo(value)} is not in the allowed models.`,
        ),
      );
      return;
    }
    // A role with a list may use only the models of both lists.
    const entry =
      byRole !== undefined &&
      byRole !== null &&
      typeof byRole === "object" &&
      Object.hasOwn(byRole, role)
        ? (byRole as Record<string, unknown>)[role]
        : undefined;
    if (
      entry !== undefined &&
      !allowSet(entry as readonly unknown[]).has(value)
    ) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_MODEL_NOT_ALLOWED",
          path,
          `The ${who} model ${echo(value)} is not in the allowedModelsByRole list of the ${role} role.`,
        ),
      );
    }
  };

  const toolValid = new Map<string, boolean>();
  spec.lanes.forEach((lane, index) => {
    const base = ["lanes", index];
    const agent = lane.agent;
    checkProvider(agent.providerId, [...base, "agent", "providerId"], "agent");
    checkModel(agent.model, [...base, "agent", "model"], "agent", lane.role);

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

    const grant = new Set(agent.mcp ?? []);
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
      if (!mcpToolGranted(tool, grant)) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_MCP_TOOL_NOT_GRANTED",
            path,
            `The tool ${echo(tool)} reaches an MCP provider that is not in this agent's mcp list.`,
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

    // MCP providers are names the host resolves: deny by default, compared
    // exactly with the allowlist, unique ignoring case (like lane ids, a host
    // may derive file or config names from them).
    const seenMcp = new Set<string>();
    (agent.mcp ?? []).forEach((id, mcpIndex) => {
      const path = [...base, "agent", "mcp", mcpIndex];
      if (!mcpProviders.has(id) || !MCP_PROVIDER_SCHEMA.safeParse(id).success) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED",
            path,
            `The MCP provider ${echo(id)} is not in the allowed MCP providers.`,
          ),
        );
      }
      const folded = id.toLowerCase();
      if (seenMcp.has(folded)) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_MCP_PROVIDER_DUPLICATE",
            path,
            `The MCP provider ${echo(id)} is listed more than once for this agent, ignoring case.`,
          ),
        );
      } else {
        seenMcp.add(folded);
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
      checkModel(
        review.model,
        [...reviewBase, "model"],
        "reviewer",
        "reviewer",
      );
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

/**
 * Built-in Claude Code tools that read the resources of every connected MCP
 * server, compared ignoring case (Claude Code matches built-in names that
 * way).
 */
const MCP_RESOURCE_TOOLS = new Set([
  "listmcpresourcestool",
  "readmcpresourcetool",
]);

/**
 * Whether a tool name that reaches an MCP server is covered by the agent's
 * MCP grant; true for every other tool name.
 *
 * @remarks
 * Fails closed. A name whose prefix is `mcp__` in any case is an MCP tool
 * name: it is granted only as exactly `mcp__<id>` (every tool of the
 * provider) or `mcp__<id>__<tool>` with a non-empty tool part, where `<id>`
 * is in the grant exactly. An id never contains `__`, so the first `__`
 * after the prefix ends it. The MCP resource tools are granted only when the
 * grant is not empty.
 */
function mcpToolGranted(tool: string, grant: ReadonlySet<string>): boolean {
  if (MCP_RESOURCE_TOOLS.has(tool.toLowerCase())) return grant.size > 0;
  if (!tool.toLowerCase().startsWith("mcp__")) return true;
  if (!tool.startsWith("mcp__")) return false;
  const rest = tool.slice("mcp__".length);
  const end = rest.indexOf("__");
  if (end === -1) return grant.has(rest);
  // An empty id (`mcp____t`) is never in a grant: ids have one character
  // at least.
  return rest.length > end + 2 && grant.has(rest.slice(0, end));
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
