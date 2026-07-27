/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { BaseAgent } from "@google/adk";
import packageJson from "../../package.json";
import * as root from "../../src/index.js";
import * as workflows from "../../src/workflows/index.js";

describe("workflows public exports", () => {
  test("root export remains LLM-focused", () => {
    expect(root.OpenAI).toBeFunction();
    expect("WorkflowAgent" in root).toBe(false);
    expect("ScriptWorkflowAgent" in root).toBe(false);
  });

  test("./workflows exposes the first-class workflow surface", () => {
    expect(workflows.BaseAgent).toBe(BaseAgent);
    expect(workflows.WorkflowAgent).toBeFunction();
    expect(workflows.ScriptWorkflowAgent).toBeFunction();
    expect(workflows.defineWorkflow).toBeFunction();
    expect(workflows.defineScriptWorkflow).toBeFunction();
    expect(workflows.WorkflowDefinitionRegistry).toBeFunction();
    expect(workflows.ADKSessionCheckpointStore).toBeFunction();
    expect(workflows.QuickJSSyncGeneratorRuntime).toBeFunction();
    expect(workflows.runWorkflowScript).toBeFunction();
  });

  test("package exports publishes the workflows subpath", () => {
    expect(packageJson.exports["./workflows"]).toEqual({
      types: "./dist/workflows/index.d.ts",
      import: "./dist/workflows/index.js",
    });
  });
});
