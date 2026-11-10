import { BasePlugin, type Event, type InvocationContext } from "@google/adk";
import {
  WorkflowEventExportPipeline,
  type WorkflowEventExportPipelineOptions,
} from "./event-export-pipeline.js";

/** Default name of {@link WorkflowEventExportPlugin}. */
export const WORKFLOW_EVENT_EXPORT_PLUGIN_NAME =
  "adk_llm_bridge_workflow_event_export";

const DEFAULT_FLUSH_ON_RUN_END_MS = 2000;

/**
 * Options of {@link WorkflowEventExportPlugin}: either an existing pipeline,
 * or the options to create one.
 *
 * @experimental
 */
export type WorkflowEventExportPluginOptions = (
  | {
      /** Pipeline to feed; share one with `WorkflowSpanExportProcessor`. */
      pipeline: WorkflowEventExportPipeline;
    }
  | WorkflowEventExportPipelineOptions
) & {
  /**
   * Plugin name; unique among the plugins of a Runner.
   *
   * @defaultValue {@link WORKFLOW_EVENT_EXPORT_PLUGIN_NAME}
   */
  name?: string;
  /**
   * Export events marked `partial` (streaming chunks).
   *
   * @defaultValue `false`
   */
  includePartial?: boolean;
  /**
   * Longest time the end of a run waits for buffered records, in
   * milliseconds. `0` does not wait.
   *
   * @defaultValue 2000
   */
  flushOnRunEndMs?: number;
};

/**
 * ADK Runner plugin that exports every event the Runner yields as workflow,
 * step and agent-run records.
 *
 * @remarks
 * Register it in the `plugins` list of the Runner (or of the `App`). It only
 * observes: `onEventCallback` queues the event and returns `undefined`, so
 * the event is never changed or delayed, and it catches its own errors. The
 * end of a run waits for the buffer for at most `flushOnRunEndMs`. Without
 * the plugin nothing in the workflow runtime changes.
 *
 * @example
 * ```ts
 * import { Runner } from "@google/adk";
 * import { getWorkflowEventExporterFromUri, WorkflowEventExportPlugin } from "adk-llm-bridge/workflows";
 *
 * const exporter = await getWorkflowEventExporterFromUri("file:///var/lib/app/events");
 * const runner = new Runner({ appName, agent, sessionService, plugins: [new WorkflowEventExportPlugin({ exporter })] });
 * ```
 *
 * @experimental
 */
export class WorkflowEventExportPlugin extends BasePlugin {
  /** The pipeline this plugin feeds. */
  readonly pipeline: WorkflowEventExportPipeline;
  readonly #includePartial: boolean;
  readonly #flushOnRunEndMs: number;

  /**
   * Creates the plugin.
   *
   * @param options - A pipeline or the options to create one, plus the
   * plugin name, the partial-event rule and the end-of-run wait.
   */
  constructor(options: WorkflowEventExportPluginOptions) {
    super(options.name ?? WORKFLOW_EVENT_EXPORT_PLUGIN_NAME);
    this.pipeline =
      "pipeline" in options
        ? options.pipeline
        : new WorkflowEventExportPipeline(options);
    this.#includePartial = options.includePartial === true;
    const wait = options.flushOnRunEndMs;
    this.#flushOnRunEndMs =
      typeof wait === "number" && Number.isFinite(wait) && wait >= 0
        ? wait
        : DEFAULT_FLUSH_ON_RUN_END_MS;
  }

  /**
   * Queues the records of an event the Runner yielded.
   *
   * @param params - The invocation context and the event.
   * @returns Always `undefined`: the event is left unchanged.
   */
  override async onEventCallback(params: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    try {
      // The pipeline remembers the execution of each invocation (bounded).
      this.pipeline.offerAdkEvent(params.event, {
        includePartial: this.#includePartial,
      });
    } catch {
      // The plugin only observes: an export problem never reaches the run.
    }
    return undefined;
  }

  /**
   * Waits for the buffered records of the finished run, for at most
   * `flushOnRunEndMs`.
   *
   * @param params - The invocation context.
   */
  override async afterRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    void params;
    try {
      await this.pipeline.flush(this.#flushOnRunEndMs);
    } catch {
      // A slow or failing exporter never fails the run.
    }
  }
}
