import { FunctionTool, LlmAgent, LLMRegistry } from "@google/adk";
import { OpenRouterLlm } from "adk-llm-bridge";
import { z } from "zod";

// Register OpenRouterLlm with ADK's LLMRegistry
// NOTE: We import LLMRegistry from @google/adk directly to ensure
// we register with the same instance that adk-devtools uses
LLMRegistry.register(OpenRouterLlm);

// =============================================================================
// Billing Agent Tools
// =============================================================================

const checkInvoice = new FunctionTool({
  name: "check_invoice",
  description: "Look up invoice details by invoice ID or customer email.",
  parameters: z.object({
    invoiceId: z.string().optional().describe("The invoice ID to look up"),
    email: z
      .string()
      .email()
      .optional()
      .describe("Customer email to find invoices"),
  }),
  execute: ({ invoiceId, email }) => {
    if (invoiceId) {
      return {
        status: "success",
        invoice: {
          id: invoiceId,
          amount: "$99.00",
          status: "paid",
          date: "2024-01-15",
          description: "Monthly subscription",
        },
      };
    }
    if (email) {
      return {
        status: "success",
        invoices: [
          {
            id: "INV-001",
            amount: "$99.00",
            status: "paid",
            date: "2024-01-15",
          },
          {
            id: "INV-002",
            amount: "$99.00",
            status: "pending",
            date: "2024-02-15",
          },
        ],
      };
    }
    return { status: "error", message: "Please provide invoiceId or email" };
  },
});

const processRefund = new FunctionTool({
  name: "process_refund",
  description: "Process a refund request for a specific invoice.",
  parameters: z.object({
    invoiceId: z.string().describe("The invoice ID to refund"),
    reason: z.string().describe("Reason for the refund"),
  }),
  execute: ({ invoiceId, reason }) => {
    return {
      status: "success",
      refundId: `REF-${Date.now()}`,
      invoiceId,
      message: `Refund initiated for invoice ${invoiceId}. Processing time: 3-5 business days.`,
      reason,
    };
  },
});

// =============================================================================
// Support Agent Tools
// =============================================================================

const checkSystemStatus = new FunctionTool({
  name: "check_system_status",
  description: "Check the current status of system services.",
  parameters: z.object({
    service: z
      .enum(["api", "web", "database", "auth", "all"])
      .optional()
      .describe("Specific service to check, or 'all' for complete status"),
  }),
  execute: ({ service = "all" }) => {
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
  parameters: z.object({
    email: z.string().email().describe("User's email address"),
  }),
  execute: ({ email }) => {
    return {
      status: "success",
      message: `Password reset link sent to ${email}. Link expires in 1 hour.`,
    };
  },
});

// =============================================================================
// Sub-Agents
// =============================================================================

const billingAgent = new LlmAgent({
  name: "Billing",
  model: "xiaomi/mimo-v2-flash:free",
  description:
    "Handles billing inquiries, invoice lookups, and refund requests.",
  instruction: `You are a billing specialist assistant. Help customers with:
- Invoice lookups and payment status
- Refund requests and processing
- Billing questions and payment issues

Be professional, empathetic, and efficient. Always verify the invoice/account before processing refunds.`,
  tools: [checkInvoice, processRefund],
});

const supportAgent = new LlmAgent({
  name: "Support",
  model: "arcee-ai/trinity-mini:free",
  description:
    "Handles technical support requests, login issues, and system status.",
  instruction: `You are a technical support specialist. Help customers with:
- Login and authentication issues
- Password resets
- System status inquiries
- Technical troubleshooting

Be patient and guide users step by step. Check system status when relevant to issues.`,
  tools: [checkSystemStatus, resetPassword],
});

// =============================================================================
// Coordinator (Root Agent)
// =============================================================================

export const rootAgent = new LlmAgent({
  name: "HelpDeskCoordinator",
  model: "nvidia/nemotron-3-nano-30b-a3b:free",
  description:
    "Main help desk router that directs users to the appropriate specialist.",
  instruction: `You are a help desk coordinator. Your job is to:

1. Greet the user and understand their issue
2. Route to the appropriate specialist:
   - **Billing**: Payment issues, invoices, refunds, subscription questions
   - **Support**: Login problems, password resets, technical issues, system status

When routing, briefly explain which specialist will help them.
If unclear, ask clarifying questions before routing.`,
  subAgents: [billingAgent, supportAgent],
});
