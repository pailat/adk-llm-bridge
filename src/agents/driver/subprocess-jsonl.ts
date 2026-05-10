/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "../external-agent-driver";
import { isExternalAgentEvent, type ExternalAgentEvent } from "../events";

export interface SubprocessJsonlDriverConfig {
  providerId: string;
  command: string;
  args?: readonly string[];
}

/**
 * Foundation placeholder for JSONL subprocess-backed drivers.
 *
 * The class intentionally performs no work until `run` is called, which keeps
 * imports free of CLI execution, auth prompts, and other side effects.
 */
export class SubprocessJsonlDriver implements ExternalAgentDriver {
  readonly providerId: string;
  readonly command: string;
  readonly args: readonly string[];

  constructor(config: SubprocessJsonlDriverConfig) {
    this.providerId = config.providerId;
    this.command = config.command;
    this.args = config.args ?? [];
  }

  async *run(_request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    yield {
      type: "error",
      message:
        "Subprocess JSONL execution is a provider-driver concern and is not implemented in the foundation layer.",
      recoverable: true,
    };
  }

  parseLine(line: string): ExternalAgentEvent {
    const parsed = JSON.parse(line) as unknown;
    if (!isExternalAgentEvent(parsed)) {
      throw new Error("Invalid external agent JSONL event");
    }
    return parsed;
  }
}
