/**
 * The `toolArgsAllowlist` driver option: a closed list of the shell commands
 * an agent may run, written as Claude Code permission rules
 * (`Bash(git log:*)`, `Bash(bun test)`). Not part of the public API.
 */

import {
  EXTERNAL_AGENT_TOOL_ARGS_RULE_INVALID,
  ExternalAgentPolicyError,
} from "./policy-errors.js";

/** One parsed rule. */
export interface ToolArgsRule {
  /** The tool the rule narrows. Only `Bash` has argument rules. */
  readonly tool: "Bash";
  /**
   * `exact`: the command must equal `value`. `prefix` (a rule ending in
   * `:*`): the command is `value`, or `value`, a space and more arguments.
   */
  readonly kind: "exact" | "prefix";
  /** The command, or the command prefix without `:*`. */
  readonly value: string;
}

/** A parsed, frozen `toolArgsAllowlist`. */
export interface ToolArgsAllowlist {
  /** The rules, in the order given. */
  readonly rules: readonly ToolArgsRule[];
}

/**
 * Claude Code tools that run shell commands, keyed by lowercase name (the
 * model or SDK may report `bash` for `Bash`), to their canonical spelling.
 * Only `Bash` has rules; the others are always denied. `Monitor` runs its
 * `command` as a shell command or script.
 */
const SHELL_TOOLS: ReadonlyMap<string, string> = new Map([
  ["bash", "Bash"],
  ["powershell", "PowerShell"],
  ["monitor", "Monitor"],
]);

/**
 * Characters that chain, substitute, redirect or escape in a shell command.
 * A command holding one could run more than the rule names (`git log && rm`),
 * so neither a rule nor a matched command may contain one.
 */
const SHELL_OPERATORS = /[;&|`$<>()\\\r\n]/u;

/** `Tool(spec)`, the Claude Code permission rule shape. */
const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/su;

/**
 * Parses and checks a `toolArgsAllowlist` option.
 *
 * @param owner - The driver, for the message.
 * @param value - The option as configured.
 * @returns The frozen allowlist; `undefined` when the option is unset (off).
 * @throws ExternalAgentPolicyError with `EXTERNAL_AGENT_TOOL_ARGS_RULE_INVALID`
 * when `value` is not an array of well-formed rules; the message names the
 * first malformed entry.
 */
export function parseToolArgsAllowlist(
  owner: string,
  value: unknown,
): ToolArgsAllowlist | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalid(owner, "must be an array of rules such as Bash(git log:*).");
  }
  const rules = [...value].map((entry) => parseRule(owner, entry));
  return Object.freeze({ rules: Object.freeze(rules) });
}

function parseRule(owner: string, entry: unknown): ToolArgsRule {
  if (typeof entry !== "string") {
    throw invalid(
      owner,
      `has an entry that is not a string (${typeof entry}).`,
    );
  }
  const shape = RULE_SHAPE.exec(entry);
  if (!shape) {
    throw invalid(
      owner,
      `entry ${JSON.stringify(entry)} is not Bash(<command>) or Bash(<prefix>:*).`,
    );
  }
  const [, tool, spec = ""] = shape;
  if (tool !== "Bash") {
    throw invalid(
      owner,
      `entry ${JSON.stringify(entry)} names ${tool}, which has no argument rules; only Bash does. Narrow other tools with tools.`,
    );
  }
  const prefix = spec.endsWith(":*");
  const command = prefix ? spec.slice(0, -2) : spec;
  if (command === "" || command.trim() !== command) {
    throw invalid(
      owner,
      `entry ${JSON.stringify(entry)} has an empty or padded command.`,
    );
  }
  if (command.includes("*")) {
    throw invalid(
      owner,
      `entry ${JSON.stringify(entry)} has a * that is not a final :*; only prefix rules (Bash(<prefix>:*)) take a wildcard.`,
    );
  }
  if (SHELL_OPERATORS.test(command)) {
    throw invalid(
      owner,
      `entry ${JSON.stringify(entry)} holds a shell operator; list each command on its own.`,
    );
  }
  return Object.freeze({
    tool: "Bash",
    kind: prefix ? "prefix" : "exact",
    value: command,
  });
}

function invalid(owner: string, detail: string): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_TOOL_ARGS_RULE_INVALID,
    `${owner}: toolArgsAllowlist ${detail}`,
  );
}

/**
 * Why a tool call is outside the allowlist, or `undefined` when it may run.
 *
 * @remarks
 * Only shell tools are checked; every other tool is left to `tools` and the
 * permission policy. A `Bash` call runs only when its `command`, trimmed,
 * matches a rule and holds no shell operator. A shell tool with no rule form
 * (`PowerShell`, `Monitor`) is always denied, so it cannot run what `Bash`
 * may not. Tool names are matched case-insensitively and trimmed, so a call
 * reported as `bash` is checked like `Bash`.
 *
 * @param allowlist - The parsed allowlist.
 * @param toolName - The tool name as the runtime reports it.
 * @param input - The tool call's arguments.
 * @returns The reason to deny the call, or `undefined`.
 */
export function toolArgsDenial(
  allowlist: ToolArgsAllowlist,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const shell = SHELL_TOOLS.get(toolName.trim().toLowerCase());
  if (shell === undefined) return undefined;
  if (shell !== "Bash") {
    return `Denied: ${shell} has no rules in this agent's toolArgsAllowlist, so it cannot run.`;
  }
  const raw = input.command;
  if (typeof raw !== "string") {
    return "Denied: a Bash call without a command cannot be checked against this agent's toolArgsAllowlist.";
  }
  const command = raw.trim();
  if (
    !SHELL_OPERATORS.test(command) &&
    allowlist.rules.some((rule) => matches(rule, command))
  ) {
    return undefined;
  }
  return `Denied: the command is not in this agent's toolArgsAllowlist (allowed: ${describe(allowlist)}). Commands with ;, &, |, $, backticks, redirects or line breaks never match.`;
}

function matches(rule: ToolArgsRule, command: string): boolean {
  return rule.kind === "exact"
    ? command === rule.value
    : command === rule.value || command.startsWith(`${rule.value} `);
}

function describe(allowlist: ToolArgsAllowlist): string {
  if (allowlist.rules.length === 0) return "none";
  return allowlist.rules
    .map((rule) =>
      rule.kind === "prefix" ? `Bash(${rule.value}:*)` : `Bash(${rule.value})`,
    )
    .join(", ");
}
