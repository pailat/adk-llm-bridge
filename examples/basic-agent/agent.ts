import { FunctionTool, LlmAgent, LLMRegistry } from "@google/adk";
import { AIGatewayLlm } from "../../src";
import { z } from "zod";

// Register AIGatewayLlm with the LLMRegistry from this bundle
// This is required for adk-devtools which bundles @google/adk separately
LLMRegistry.register(AIGatewayLlm);

const getCurrentTime = new FunctionTool({
  name: "get_current_time",
  description: "Returns the current time in a specified city.",
  parameters: z.object({
    city: z.string().describe("The name of the city"),
  }),
  execute: ({ city }) => {
    const time = new Date().toLocaleTimeString("en-US", {
      timeZone: city === "Tokyo" ? "Asia/Tokyo" : "America/New_York",
    });
    return { status: "success", time, city };
  },
});

export const rootAgent = new LlmAgent({
  name: "time_agent",
  model: "zai/glm-4.6", // Uses registered AIGatewayLlm
  description: "An agent that tells the current time in any city.",
  instruction: `You are a helpful assistant that tells the current time.
Use the 'get_current_time' tool when asked about time in a city.`,
  tools: [getCurrentTime],
});
