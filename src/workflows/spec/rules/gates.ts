import { type RunSpecIssue, runSpecIssue } from "../issues.js";
import { type RunRules, type RunSpec, runSpecCommandKey } from "../schema.js";

/**
 * Checks the gates rules of a run spec whose shape is already valid and
 * appends one issue per violation.
 *
 * @remarks
 * QA ids must be unique (compared exactly, case-sensitive). Each QA command
 * must equal an entry of the allowlist as a whole argument list; no
 * normalization is applied. A spec that publishes needs QA when the rules
 * ask for it, and its publish kind must be allowed. A commit or merge always
 * needs `hitl` to be exactly `true`, whatever the rules say.
 *
 * @param spec - The spec, already shape-checked.
 * @param rules - The host's rules.
 * @param issues - Receives the issues found.
 * @experimental
 */
export function checkGateRules(
  spec: RunSpec,
  rules: RunRules,
  issues: RunSpecIssue[],
): void {
  const { qa, publish } = spec.gates;

  const seenIds = new Set<string>();
  for (let i = 0; i < qa.length; i++) {
    const id = qa[i]?.id as string;
    if (seenIds.has(id)) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_QA_ID_DUPLICATE",
          ["gates", "qa", i, "id"],
          "A QA command id appears more than once.",
        ),
      );
    }
    seenIds.add(id);
  }

  const allowed = new Set<string>();
  for (const entry of rules.allowedQaCommands) {
    allowed.add(runSpecCommandKey(entry));
  }
  for (let i = 0; i < qa.length; i++) {
    const command = qa[i]?.command as readonly string[];
    if (!allowed.has(runSpecCommandKey(command))) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_QA_COMMAND_NOT_ALLOWED",
          ["gates", "qa", i, "command"],
          "A QA command is not in the rule set's allowed commands.",
        ),
      );
    }
  }

  const kind: string = publish.kind;
  const publishes = kind !== "none";

  if (publishes && rules.requireQa && qa.length === 0) {
    issues.push(
      runSpecIssue(
        "RUN_SPEC_QA_REQUIRED",
        ["gates", "qa"],
        "A spec that publishes must declare at least one QA command.",
      ),
    );
  }

  if (!rules.allowedPublishKinds.some((allowedKind) => allowedKind === kind)) {
    issues.push(
      runSpecIssue(
        "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
        ["gates", "publish", "kind"],
        "The publish kind is not in the rule set's allowed kinds.",
      ),
    );
  }

  if (
    (kind === "commit" || kind === "integration") &&
    (publish as { hitl?: unknown }).hitl !== true
  ) {
    issues.push(
      runSpecIssue(
        "RUN_SPEC_HITL_REQUIRED",
        ["gates", "publish", "hitl"],
        "A spec that commits or merges requires human approval (hitl must be true).",
      ),
    );
  }
}
