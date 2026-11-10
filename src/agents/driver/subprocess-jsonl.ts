import { type ExternalAgentEvent, isExternalAgentEvent } from "../events.js";
import type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "../external-agent-driver.js";

/** Options for {@link SubprocessJsonlDriver}. */
export interface SubprocessJsonlDriverConfig {
  /** Provider id reported in `started` events. */
  providerId: string;
  /** Executable to run. */
  command: string;
  /**
   * Arguments for the executable.
   *
   * @defaultValue []
   */
  args?: readonly string[];
}

/**
 * Base class for drivers that read JSON lines from a subprocess.
 *
 * @remarks
 * The base `run` does not spawn anything: it yields one recoverable `error`
 * event. Subclasses such as `CodexCliDriver` override `run`. The class
 * performs no work until `run` is called, which keeps imports free of CLI
 * execution, auth prompts and other side effects.
 */
export class SubprocessJsonlDriver implements ExternalAgentDriver {
  /** Provider id reported in `started` events. */
  readonly providerId: string;
  /** Executable to run. */
  readonly command: string;
  /** Arguments for the executable. */
  readonly args: readonly string[];

  /** @param config - Provider id, command and arguments. */
  constructor(config: SubprocessJsonlDriverConfig) {
    this.providerId = config.providerId;
    this.command = config.command;
    this.args = config.args ?? [];
  }

  /**
   * Placeholder run: yields a recoverable `error` event and ends.
   *
   * @param _request - Ignored by the base class.
   * @returns A single `error` event.
   */
  async *run(
    _request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    yield {
      type: "error",
      message:
        "Subprocess JSONL execution is a provider-driver concern and is not implemented in the foundation layer.",
      recoverable: true,
    };
  }

  /**
   * Parses one JSON line as an external agent event.
   *
   * @param line - One line of subprocess output.
   * @returns The event.
   * @throws SyntaxError when the line is not JSON.
   * @throws Error when the JSON is not a valid external agent event.
   */
  parseLine(line: string): ExternalAgentEvent {
    const parsed = JSON.parse(line) as unknown;
    if (!isExternalAgentEvent(parsed)) {
      throw new Error("Invalid external agent JSONL event");
    }
    return parsed;
  }
}
