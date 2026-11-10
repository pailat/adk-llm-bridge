/**
 * Internal helpers that read a subprocess's output. Not part of the public
 * API: do not re-export from any barrel (the drivers re-export
 * {@link LineSource} because their subprocess types use it).
 */

/** A source of output chunks (text or bytes) the driver splits into lines. */
export type LineSource =
  | ReadableStream<Uint8Array | string>
  | AsyncIterable<Uint8Array | string>
  | Iterable<Uint8Array | string>;

/** How many stderr lines a driver keeps for its error messages. */
export const STDERR_TAIL_LINES = 200;

/** Longest stderr line a driver keeps; longer lines are cut. */
export const STDERR_LINE_CHARS = 4096;

/** Options of {@link readLines}. */
export interface ReadLinesOptions {
  /**
   * Longest line kept, in characters. A longer line is cut and ends with
   * `...`; the rest of it is skipped up to the next newline without being
   * held in memory. Unset keeps lines whole.
   */
  maxLineChars?: number;
}

/**
 * Splits a byte or text stream into lines.
 *
 * @remarks
 * Multibyte characters split across chunks are decoded correctly, a trailing
 * `\r` is removed, and a last line without a newline is still yielded. A
 * `ReadableStream` reader is released when reading ends or stops early.
 *
 * @param input - The stream; `null` or `undefined` yields nothing.
 * @param options - An optional line length cap.
 * @returns The lines, without their line endings.
 */
export async function* readLines(
  input?: LineSource | null,
  options: ReadLinesOptions = {},
): AsyncIterable<string> {
  if (!input) {
    return;
  }

  const max = options.maxLineChars;
  const cap = (line: string) =>
    max !== undefined && line.length > max ? `${line.slice(0, max)}...` : line;
  const decoder = new TextDecoder();
  let buffer = "";
  // The kept start of a line that grew past `max` before its newline came.
  let cut: string | undefined;

  for await (const chunk of chunksOf(input)) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      if (cut !== undefined) {
        yield `${cut}...`;
        cut = undefined;
      } else {
        yield cap(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      }
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
    if (cut !== undefined) {
      buffer = "";
    } else if (max !== undefined && buffer.length > max) {
      cut = buffer.slice(0, max);
      buffer = "";
    }
  }

  buffer += decoder.decode();
  if (cut !== undefined) {
    yield `${cut}...`;
  } else if (buffer.length > 0) {
    yield cap(buffer.replace(/\r$/, ""));
  }
}

/**
 * Reads every non-blank line into `target`, keeping only the last ones.
 *
 * @remarks
 * Bounds memory for a chatty process: once `target` holds `maxLines` lines
 * the oldest is dropped, and each line is cut to {@link STDERR_LINE_CHARS}
 * characters, even while it is still arriving without a newline.
 *
 * @param input - The stream.
 * @param target - Receives the lines, oldest first.
 * @param maxLines - How many lines to keep.
 */
export async function collectTail(
  input: LineSource | null | undefined,
  target: string[],
  maxLines: number = STDERR_TAIL_LINES,
): Promise<void> {
  for await (const line of readLines(input, {
    maxLineChars: STDERR_LINE_CHARS,
  })) {
    if (line.trim().length === 0) {
      continue;
    }
    target.push(line);
    if (target.length > maxLines) {
      target.shift();
    }
  }
}

/**
 * Reads a whole stream as text.
 *
 * @param input - The stream; `null` or `undefined` gives an empty string.
 * @returns The decoded text.
 */
export async function readAll(input?: LineSource | null): Promise<string> {
  if (!input) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of chunksOf(input)) {
    text +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function* chunksOf(
  input: LineSource,
): AsyncIterable<Uint8Array | string> {
  const asyncIterable = input as AsyncIterable<Uint8Array | string>;
  if (typeof asyncIterable[Symbol.asyncIterator] === "function") {
    yield* asyncIterable;
    return;
  }

  const iterable = input as Iterable<Uint8Array | string>;
  if (typeof iterable[Symbol.iterator] === "function") {
    yield* iterable;
    return;
  }

  const reader = (input as ReadableStream<Uint8Array | string>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
