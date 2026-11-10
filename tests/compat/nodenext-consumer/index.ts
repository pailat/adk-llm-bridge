import {
  CodexAgent,
  type ExternalAgent,
  ExternalAgentDefinitionRegistry,
  GeminiCliAgent,
} from "../../../dist/agents/index.js";
import { OpenAI, OpenRouter } from "../../../dist/index.js";
import {
  defineScriptWorkflow,
  defineWorkflow,
  ExternalAgentWorkflowFactory,
  type ExternalAgentWorkflowFactoryOptions,
  ScriptWorkflowAgent,
  WorkflowAgent,
} from "../../../dist/workflows/index.js";
import {
  RunSpecSchema,
  validateRunSpec,
} from "../../../dist/workflows/spec/index.js";

void OpenAI;
void OpenRouter;
void CodexAgent;
void GeminiCliAgent;
void WorkflowAgent;
void ScriptWorkflowAgent;
void defineWorkflow;
void defineScriptWorkflow;
void RunSpecSchema;
void validateRunSpec;

// Classes with `#private` members are nominal: a class declared once per entry
// in the `.d.ts` files would make these cross-entry uses fail to compile.
const registry = new ExternalAgentDefinitionRegistry();
void new ExternalAgentWorkflowFactory({ registry });
// The agent a workflows-side registry creates is the `/agents` class.
type WorkflowsRegistry = ExternalAgentWorkflowFactoryOptions["registry"];
const created: ExternalAgent = undefined as unknown as ReturnType<
  WorkflowsRegistry["create"]
>;
void created;
