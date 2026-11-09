import type { InvocationContext } from "@google/adk";
import type { Content, Part } from "@google/genai";

/**
 * Builds the conversation history of the current invocation from the session
 * events.
 *
 * @remarks
 * Reimplements ADK's `getContents` (in `content_processor_utils.js` of the
 * `@google/adk` package), which the package does not export. It filters
 * events by branch and visibility, rewrites foreign-agent turns into user-role
 * context markers, and reorders async function-call/response pairs so each
 * response sits adjacent to its call.
 *
 * @param context - The ADK invocation context. A context without a session
 * yields an empty list.
 * @returns The history as `Content` turns, ending with the user's message.
 */
export function collectContents(context: InvocationContext): Content[] {
  const ctxRecord = (context ?? {}) as unknown as Record<string, unknown>;
  const session = ctxRecord.session as
    | { events?: ReadonlyArray<AdkEventLike> }
    | undefined;
  // A context without a session is synthetic; the driver falls back to
  // rebuilding the prompt from the context text.
  if (!session || !Array.isArray(session.events)) {
    return [];
  }
  const events: ReadonlyArray<AdkEventLike> = session.events;
  const agentName = (ctxRecord.agent as { name?: string } | undefined)?.name;
  const currentBranch =
    typeof ctxRecord.branch === "string"
      ? (ctxRecord.branch as string)
      : undefined;
  const userContent = ctxRecord.userContent as Content | undefined;

  const filtered: AdkEventLike[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    if (event.partial === true) {
      continue;
    }
    const content = event.content;
    if (
      !content ||
      !Array.isArray(content.parts) ||
      content.parts.length === 0
    ) {
      continue;
    }
    if (!hasVisibleContent(content.parts)) {
      continue;
    }
    if (
      currentBranch &&
      event.branch &&
      currentBranch !== event.branch &&
      !currentBranch.startsWith(`${event.branch}.`)
    ) {
      continue;
    }

    if (isForeignEvent(agentName, event)) {
      filtered.push(rewriteForeignEvent(event));
    } else {
      filtered.push(event);
    }
  }

  const reordered = rearrangeAsyncFunctionResponses(filtered);

  const contents: Content[] = [];
  for (const event of reordered) {
    if (event.content) {
      contents.push(normalizeContent(event.content));
    }
  }

  if (userContent) {
    const last = contents[contents.length - 1];
    if (!last || last !== userContent) {
      contents.push(userContent);
    }
  }

  return contents;
}

/**
 * Renders `Content[]` into a deterministic prompt string for external runtimes
 * that consume a single text turn.
 *
 * @param contents - The conversation turns.
 * @returns One block per turn, headed `assistant:` or `user:`. Thought parts
 * are omitted and non-text parts are rendered as short bracketed markers.
 */
export function flattenContentsToPrompt(
  contents: ReadonlyArray<Content>,
): string {
  const blocks: string[] = [];
  for (const content of contents) {
    const header = content.role === "model" ? "assistant:" : "user:";
    const partStrings: string[] = [];
    for (const part of content.parts ?? []) {
      const rendered = renderPart(part);
      if (rendered !== undefined) {
        partStrings.push(rendered);
      }
    }
    if (partStrings.length === 0) {
      continue;
    }
    blocks.push(`${header}\n${partStrings.join("\n")}`);
  }
  return blocks.join("\n\n").replace(/\s+$/g, "");
}

// --- internals ----------------------------------------------------------------

type AdkEventLike = {
  author?: string;
  branch?: string;
  partial?: boolean;
  content?: Content;
};

function hasVisibleContent(parts: ReadonlyArray<Part>): boolean {
  for (const part of parts) {
    if (typeof part.text === "string" && part.text.length > 0) {
      return true;
    }
    if (
      part.inlineData ||
      part.fileData ||
      part.functionCall ||
      part.functionResponse
    ) {
      return true;
    }
  }
  return false;
}

function isForeignEvent(
  agentName: string | undefined,
  event: AdkEventLike,
): boolean {
  if (!agentName) {
    return false;
  }
  const author = event.author;
  return !!author && author !== "user" && author !== agentName;
}

function rewriteForeignEvent(event: AdkEventLike): AdkEventLike {
  const author = event.author ?? "unknown";
  const parts = event.content?.parts ?? [];
  const textParts: string[] = [];
  const newParts: Part[] = [];

  for (const part of parts) {
    if (
      typeof part.text === "string" &&
      part.text.length > 0 &&
      !part.thought
    ) {
      textParts.push(part.text);
    }
  }
  if (textParts.length > 0) {
    newParts.push({ text: `[${author} said: ${textParts.join("")}]` });
  }
  for (const part of parts) {
    if (part.functionCall) {
      const args = part.functionCall.args ?? {};
      newParts.push({
        text: `[${author} called tool ${part.functionCall.name ?? "<unknown>"} with parameters ${safeJsonStringify(args)}]`,
      });
    }
    // functionResponse, inlineData and fileData from foreign agents are
    // dropped: only what the other agent said and asked for is relevant context.
  }

  return {
    author: "user",
    branch: event.branch,
    content: { role: "user", parts: newParts },
  };
}

/**
 * Single-pass reorder: for each event with `functionCall` parts, if any matching
 * `functionResponse` event lives later in the array we emit it immediately after
 * the call. Mirrors the common-case behaviour of ADK's
 * `rearrangeEventsForAsyncFunctionResponsesInHistory`.
 */
function rearrangeAsyncFunctionResponses(
  events: AdkEventLike[],
): AdkEventLike[] {
  const responseIndexById = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    for (const part of events[i].content?.parts ?? []) {
      const id = part.functionResponse?.id;
      if (id) {
        responseIndexById.set(id, i);
      }
    }
  }

  const consumed = new Set<number>();
  const result: AdkEventLike[] = [];
  for (let i = 0; i < events.length; i++) {
    if (consumed.has(i)) {
      continue;
    }
    const event = events[i];
    const isResponseEvent = (event.content?.parts ?? []).some(
      (part) => part.functionResponse,
    );
    if (isResponseEvent && hasMatchingEarlierCall(events, event, i)) {
      // Appended right after its call, so it is skipped at its own position.
      continue;
    }
    result.push(event);

    const callIds = collectCallIds(event);
    if (callIds.length === 0) {
      continue;
    }
    for (const callId of callIds) {
      const responseIdx = responseIndexById.get(callId);
      if (
        responseIdx !== undefined &&
        responseIdx !== i &&
        !consumed.has(responseIdx)
      ) {
        result.push(events[responseIdx]);
        consumed.add(responseIdx);
      }
    }
  }
  return result;
}

function collectCallIds(event: AdkEventLike): string[] {
  const ids: string[] = [];
  for (const part of event.content?.parts ?? []) {
    const id = part.functionCall?.id;
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function hasMatchingEarlierCall(
  events: AdkEventLike[],
  responseEvent: AdkEventLike,
  responseIdx: number,
): boolean {
  const respIds = new Set<string>();
  for (const part of responseEvent.content?.parts ?? []) {
    const id = part.functionResponse?.id;
    if (id) {
      respIds.add(id);
    }
  }
  if (respIds.size === 0) {
    return false;
  }
  for (let i = 0; i < responseIdx; i++) {
    for (const part of events[i].content?.parts ?? []) {
      const id = part.functionCall?.id;
      if (id && respIds.has(id)) {
        return true;
      }
    }
  }
  return false;
}

function normalizeContent(content: Content): Content {
  const role: "user" | "model" = content.role === "model" ? "model" : "user";
  return { role, parts: content.parts ?? [] };
}

function renderPart(part: Part): string | undefined {
  if (part.thought) {
    return undefined;
  }
  if (typeof part.text === "string" && part.text.length > 0) {
    return part.text;
  }
  if (part.inlineData) {
    const mime = part.inlineData.mimeType ?? "application/octet-stream";
    if (mime.startsWith("image/")) return `[image: ${mime}]`;
    if (mime.startsWith("audio/")) return `[audio: ${mime}]`;
    if (mime.startsWith("video/")) return `[video: ${mime}]`;
    return `[document: ${mime}]`;
  }
  if (part.fileData) {
    const mime = part.fileData.mimeType ?? "application/octet-stream";
    const uri = part.fileData.fileUri ?? "<unknown>";
    return `[file: ${uri} (${mime})]`;
  }
  if (part.functionCall) {
    const name = part.functionCall.name ?? "<unknown>";
    const args = part.functionCall.args ?? {};
    return `[tool_call ${name}(${safeJsonStringify(args)})]`;
  }
  if (part.functionResponse) {
    const name = part.functionResponse.name ?? "<unknown>";
    const response = part.functionResponse.response ?? {};
    return `[tool_result ${name}: ${safeJsonStringify(response)}]`;
  }
  if (part.executableCode) {
    const lang = part.executableCode.language ?? "PLAINTEXT";
    const code = part.executableCode.code ?? "";
    return `[code (${lang}): ${code}]`;
  }
  if (part.codeExecutionResult) {
    const outcome = part.codeExecutionResult.outcome ?? "OUTCOME_UNSPECIFIED";
    const output = part.codeExecutionResult.output ?? "";
    return `[exec ${outcome}: ${output}]`;
  }
  return "[unsupported-part]";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * Like {@link collectContents} but never throws. A malformed or synthetic
 * invocation context yields an empty list so callers fall back to their text
 * extractor.
 *
 * @param context - The ADK invocation context.
 * @returns The history, or an empty list on any failure.
 * @internal
 */
export function safeCollectContents(context: InvocationContext): Content[] {
  try {
    return collectContents(context);
  } catch {
    return [];
  }
}
