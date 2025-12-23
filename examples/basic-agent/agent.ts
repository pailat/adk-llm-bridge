import { FunctionTool, LlmAgent, LLMRegistry } from "@google/adk";
import { AIGatewayLlm } from "adk-llm-bridge";
import { z } from "zod";

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
  model: "anthropic/claude-sonnet-4",
  description: "An agent that tells the current time in any city.",
  instruction: `You are a helpful assistant that tells the current time.
Use the 'get_current_time' tool when asked about time in a city.`,
  tools: [getCurrentTime],
});
