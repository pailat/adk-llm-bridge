/**
 * Composition root for the demo set.
 *
 * Explicitly imports each demo module and registers its Demo into the shared
 * registry. No fs-glob auto-discovery — explicit is clearer for an example, and
 * this is the single place that knows the full demo set.
 */
import { registry } from "../registry";
import { samplingDemo } from "./sampling";
import { reasoningDemo } from "./reasoning";
import { structuredOutputDemo } from "./structured-output";
import { multimodalDemo } from "./multimodal";
import { toolChoiceDemo } from "./tool-choice";
import { streamingDemo } from "./streaming";

registry.register(samplingDemo);
registry.register(reasoningDemo);
registry.register(structuredOutputDemo);
registry.register(multimodalDemo);
registry.register(toolChoiceDemo);
registry.register(streamingDemo);

export { registry };
