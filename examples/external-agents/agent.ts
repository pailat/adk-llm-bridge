import type * as Adk from "@google/adk";
import { OpenRouter } from "adk-llm-bridge";
import {
  ClaudeAgent,
  ClaudeAgentSdkDriver,
  CodexAgent,
  EnvCredentialProvider,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";
import {
  normalizeAllowedDirectory,
  parseArchitectureAnalysisPaths,
} from "./config.js";

// This example maps @google/adk to declaration files for local type-checking.
// Import the runtime ESM build directly so Bun does not execute a .d.ts file.
const adkRuntime = await import(
  new URL(
    [
      "..",
      "..",
      "node_modules",
      "@google",
      "adk",
      "dist",
      "esm",
      "index.js",
    ].join("/"),
    import.meta.url,
  ).href
);
const { FunctionTool, LlmAgent } = adkRuntime as typeof Adk;

const openRouterModel = process.env.OPENROUTER_MODEL ?? "openrouter/auto";
const hasOpenRouterApiKey = Boolean(process.env.OPENROUTER_API_KEY);

// =============================================================================
// Billing Agent Tools / Reference Data
// =============================================================================

const billingReference = `Reference billing data:
- INV-001: $99.00, paid, 2024-01-15, Monthly subscription.
- INV-002: $99.00, pending, 2024-02-15, Monthly subscription.
- user@example.com owns INV-001 and INV-002.
Refund policy: verify invoice and reason before telling the user a refund can be initiated.`;

// =============================================================================
// Support Agent Tools
// =============================================================================

const checkSystemStatus = new FunctionTool({
  name: "check_system_status",
  description: "Check the current status of system services.",
  parameters: {
    type: "OBJECT",
    properties: {
      service: {
        type: "STRING",
        enum: ["api", "web", "database", "auth", "all"],
        description: "Specific service to check, or 'all' for complete status",
      },
    },
  } as never,
  execute: (input: unknown) => {
    const service = readService(input) ?? "all";
    const services = {
      api: { status: "operational", latency: "45ms" },
      web: { status: "operational", latency: "120ms" },
      database: { status: "operational", latency: "12ms" },
      auth: {
        status: "degraded",
        latency: "250ms",
        note: "Investigating slowness",
      },
    };

    if (service === "all") {
      return { result: "success", services };
    }
    const serviceData = services[service as keyof typeof services];
    return {
      result: "success",
      service,
      serviceStatus: serviceData.status,
      latency: serviceData.latency,
      ...("note" in serviceData ? { note: serviceData.note } : {}),
    };
  },
});

const resetPassword = new FunctionTool({
  name: "reset_password",
  description: "Send a password reset link to a user's email.",
  parameters: {
    type: "OBJECT",
    properties: {
      email: {
        type: "STRING",
        description: "User's email address",
      },
    },
    required: ["email"],
  } as never,
  execute: (input: unknown) => {
    const email = readString(input, "email") ?? "unknown@example.com";
    return {
      status: "success",
      message: `Password reset link sent to ${email}. Link expires in 1 hour.`,
    };
  },
});

// External agent runtimes are opt-in and live under the /agents subpath. This
// HelpDesk mirrors examples/basic-agent-openrouter while proving Claude Code can
// be the root ADK agent and orchestrate both external and LLM-backed subagents.
const credentialProvider = new EnvCredentialProvider();
const workingDirectory = normalizeAllowedDirectory(process.cwd());
const architectureAnalysisPaths = parseArchitectureAnalysisPaths(
  process.env.ARCHITECTURE_ANALYSIS_PATHS,
);
const allowedPaths = [
  ...new Set([workingDirectory, ...architectureAnalysisPaths]),
];

const codexBillingSpecialist = new CodexAgent({
  name: "CodexBillingSpecialist",
  description:
    "Handles billing inquiries, invoice lookups, and refund request analysis using the Codex runtime.",
  credentialProvider,
  workingDirectory,
  permissions: {
    ...mapPermissionModeToPolicy("read-only"),
    allowedPaths,
  },
  instruction: `You are a billing specialist assistant running as a Codex ADK subagent.

Help customers with invoice lookups, refund request analysis, billing questions, and payment status. Use this fixed demo data instead of modifying files or calling external services.

${billingReference}

Be professional, empathetic, and efficient. Always verify the invoice/account before saying a refund can be initiated. Do not modify files.`,
});

const openRouterSupportSpecialist = hasOpenRouterApiKey
  ? new LlmAgent({
      name: "OpenRouterSupportSpecialist",
      model: OpenRouter(openRouterModel),
      description:
        "Handles technical support requests, login issues, password resets, and system status through OpenRouter.",
      instruction: `You are a technical support specialist. Help customers with:
- Login and authentication issues
- Password resets
- System status inquiries
- Technical troubleshooting

Use your tools when checking system status or sending password reset links. Be patient and guide users step by step.`,
      tools: [checkSystemStatus, resetPassword],
    })
  : undefined;

const claudeDriver = new ClaudeAgentSdkDriver({
  // Optional fallback when package-manager postinstall scripts did not install
  // the SDK's bundled native binary. Leave these unset to use driver autodetection
  // and the SDK default.
  pathToClaudeCodeExecutable:
    process.env.CLAUDE_CODE_EXECUTABLE ?? process.env.CLAUDE_CODE_PATH,
});

export const rootAgent = new ClaudeAgent({
  name: "ClaudeCodeRoot",
  description:
    "Main HelpDesk coordinator running Claude Code as the root ADK agent.",
  credentialProvider,
  driver: claudeDriver,
  workingDirectory,
  permissions: {
    ...mapPermissionModeToPolicy("ask"),
    allowNetwork: false,
    allowedPaths,
  },
  instruction: `You are the root Claude Code HelpDesk coordinator for this example.

Use the native Claude Code authentication already configured on this machine. Your job is to greet the user, understand their issue, and delegate to the correct ADK subagent by calling the MCP tool named run_adk_subagent.

Routing rules:
- Billing, invoice lookup, payment status, refunds, and subscription questions: delegate to CodexBillingSpecialist.
${
  openRouterSupportSpecialist
    ? "- Technical support, login issues, password reset, system status, auth status, API status, and troubleshooting: delegate to OpenRouterSupportSpecialist."
    : "- Technical support via OpenRouterSupportSpecialist is disabled because OPENROUTER_API_KEY is not configured. If asked for support, explain that OPENROUTER_API_KEY is required for that subagent."
}

When delegating, call run_adk_subagent immediately before producing explanatory text. Do not narrate that you are about to delegate before the tool call. After the tool returns, summarize or relay the specialist result to the user.

If the request is unclear, ask one concise clarifying question. Ask before broad or destructive changes. Do not modify files for HelpDesk requests.

Allowed paths for runtime access: ${allowedPaths.join(", ")}.`,
  subAgents: [
    codexBillingSpecialist,
    ...(openRouterSupportSpecialist ? [openRouterSupportSpecialist] : []),
  ],
});

function readService(
  input: unknown,
): "api" | "web" | "database" | "auth" | "all" | undefined {
  const service = readString(input, "service");
  return service === "api" ||
    service === "web" ||
    service === "database" ||
    service === "auth" ||
    service === "all"
    ? service
    : undefined;
}

function readString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
