import {
  CodexAgent,
  type ExternalAgent,
  ExternalAgentDefinitionRegistry,
  FxAgent,
} from "../../../dist/agents/index.js";
import { OpenAI, OpenRouter } from "../../../dist/index.js";
import type { SqliteWorkflowCheckpointStore } from "../../../dist/workflows/checkpoint/sqlite/index.js";
import type { SqliteWorkflowEventExporter } from "../../../dist/workflows/events/sqlite/index.js";
import {
  BaseWorkflowCheckpointStore,
  BaseWorkflowEventExporter,
  defineScriptWorkflow,
  defineWorkflow,
  ExternalAgentWorkflowFactory,
  type ExternalAgentWorkflowFactoryOptions,
  InMemoryWorkflowCheckpointStore,
  InMemoryWorkflowEventExporter,
  ScriptWorkflowAgent,
  WorkflowAgent,
} from "../../../dist/workflows/index.js";
import {
  RunSpecSchema,
  validateRunSpec,
} from "../../../dist/workflows/spec/index.js";
import { workflowCheckpointStoreConformanceCases } from "../../../dist/workflows/storage/conformance/index.js";

void OpenAI;
void OpenRouter;
void CodexAgent;
void FxAgent;
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

// A custom provider subclasses the abstract bases, which are declared once.
class ConsumerCheckpointStore extends BaseWorkflowCheckpointStore {
  readonly providerName = "consumer";
  readonly capabilities = new InMemoryWorkflowCheckpointStore().capabilities;
  protected readCheckpoint(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  protected writeCheckpoint(): Promise<number> {
    return Promise.resolve(Date.now());
  }
}

class ConsumerEventExporter extends BaseWorkflowEventExporter {
  readonly providerName = "consumer";
  readonly capabilities = new InMemoryWorkflowEventExporter().capabilities;
  protected appendRecords(): never {
    throw new Error("not used");
  }
  protected readRecords(): never {
    throw new Error("not used");
  }
}
void ConsumerCheckpointStore;
void ConsumerEventExporter;

// The SQLite classes are the same base types the workflows entry declares.
const sqliteStore: BaseWorkflowCheckpointStore =
  undefined as unknown as SqliteWorkflowCheckpointStore;
const sqliteExporter: BaseWorkflowEventExporter =
  undefined as unknown as SqliteWorkflowEventExporter;
type CheckpointOption = NonNullable<
  ConstructorParameters<typeof WorkflowAgent>[0]["checkpointStore"]
>;
const checkpointOption: CheckpointOption = sqliteStore;
void checkpointOption;
void sqliteExporter;
void workflowCheckpointStoreConformanceCases;
