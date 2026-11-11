import { describe, expect, test } from "bun:test";
import { trackingIdRule } from "../../scripts/tracking-id-patterns.js";

describe("trackingIdRule", () => {
  test.each([
    ["backlog id", "// BF-TMPDIR-RESIDUAL-1 covers this", "backlog or fix id"],
    [
      "backlog id in a test name",
      "BF-M1-F4 smallFastModel",
      "backlog or fix id",
    ],
    ["fs id", "/** FS-RENAME-RETRY-1 retries */", "backlog or fix id"],
    ["backlog list id", "// see BL-QJS-WORKER", "backlog or fix id"],
    [
      "verification id",
      "// V-12 checks the spill",
      "verification or request id",
    ],
    ["request id", "// REQ-7 asked for it", "verification or request id"],
    [
      "verification id with a suffix",
      "// V-12b checks it",
      "verification or request id",
    ],
    ["hardening audit id", "// H-C flake candidate", "hardening audit id"],
  ])("flags a %s", (_name, text, rule) => {
    expect(trackingIdRule(text)).toBe(rule);
  });

  test.each([
    ["an ordinary lane word", "Steps a lane runs, in order"],
    ["a word that ends in V", "// the DEV-1 build"],
    ["a word that ends in REQ", "// the PREREQ-2 step"],
    ["a mixed-case fs name", "// the FS-Rename helper"],
    ["a request id with a suffix word", "// the REQ-7_FLAG value"],
    ["a lowercase audit id", "// an H-a pair"],
    ["a spec lane index", "// Lane 1's worker agent uses gpt-5.5"],
    ["a hyphenated word", "// the HTTP-1 and TLS-1 pair"],
    ["a version label", "// V8 and V-less code"],
    ["a word that ends like an id", "// the DEBF-1 flag"],
    ["a longer hyphenated name", "// X-H-A header"],
    ["a word that starts like an audit id", "// the H-Axis header"],
    ["an issue link", "// https://github.com/pailat/adk-llm-bridge/issues/89"],
    ["plain prose", "// retries the rename on EPERM"],
  ])("accepts %s", (_name, text) => {
    expect(trackingIdRule(text)).toBeUndefined();
  });

  test("keeps the existing rules", () => {
    expect(trackingIdRule("// STREAM-1 and more")).toBe("stream or lane id");
    expect(trackingIdRule("// see issue #89")).toBe(
      "bare issue or pull request number",
    );
  });
});
