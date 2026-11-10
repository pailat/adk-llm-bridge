import { describe, expect, test } from "bun:test";
import {
  guardPermissionRequest,
  type PermissionRequest,
} from "../../src/agents/permissions/confirmation.js";

function request(toolName: string): PermissionRequest {
  return {
    requestId: "call-1",
    toolName,
    input: { query: "exfiltrate" },
    networkSandbox: "enforced",
  };
}

describe("every runtime's network tools need allowNetwork", () => {
  for (const tool of [
    "WebFetch",
    "WebSearch",
    "web_fetch",
    "web_search",
    "google_web_search",
  ]) {
    test(`${tool} is denied without allowNetwork and left to the approver with it`, () => {
      expect(guardPermissionRequest({ mode: "ask" }, request(tool))).toEqual({
        behavior: "deny",
        message: `Denied: network access is not allowed by this agent's policy (${tool}).`,
      });
      expect(
        guardPermissionRequest(
          { mode: "ask", allowNetwork: true },
          request(tool),
        ),
      ).toBeUndefined();
    });
  }
});
