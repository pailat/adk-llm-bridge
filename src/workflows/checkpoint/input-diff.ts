import { sha256Digest } from "../internal/canonical-hash.js";
import {
  INPUT_CHUNK_DIGEST_LENGTH,
  MAX_INPUT_CHUNKS,
  MIN_INPUT_CHUNK_SIZE,
  type WorkflowCheckpointStepInputDigestV1,
  type WorkflowCheckpointStepRecordV1,
} from "./step-record.js";

/**
 * What a step input fingerprint records: the length of the canonical input
 * and, for an input longer than one chunk, a digest per chunk.
 */
export type WorkflowInputFingerprint = Pick<
  WorkflowCheckpointStepRecordV1,
  "inputLength" | "inputDigest"
> & { inputLength: number };

/**
 * Where the current step input first differs from the one a checkpoint saved.
 *
 * @remarks
 * Offsets are UTF-16 code units of the current canonical input, the string
 * `workflowStepInputCanonicalForm` returns, so
 * `workflowStepInputCanonicalForm(input).slice(start, end)` is the window. The
 * window is a whole chunk of the saved fingerprint, never narrower. When the
 * current input is the saved one cut exactly at a chunk boundary, the window
 * is empty (`start === end === length`): the current input ends where the
 * saved one went on. A surrogate pair split by a chunk boundary is encoded as
 * U+FFFD on both sides, so the comparison stays deterministic.
 *
 * `reason` says why there is no window: `not-recorded` (the step was saved
 * without a fingerprint: an older checkpoint, or a step whose input hash is a
 * pre-0.7.0 form), `disabled` (the fingerprint option is off and nothing was
 * saved), `inconclusive` (every compared chunk matches although the hashes
 * differ).
 */
export type WorkflowStepMismatchDiff =
  | {
      available: false;
      reason: "not-recorded" | "disabled" | "inconclusive";
    }
  | {
      available: true;
      /** Length of the saved canonical input. */
      savedLength: number;
      /** Length of the current canonical input. */
      length: number;
      /** Chunk size of the saved fingerprint; absent for a single-chunk saved input. */
      chunkSize?: number;
      /** First differing window, in the current canonical input. */
      firstDifference: { start: number; end: number };
      /** Structural path of the value at `start`; never input text. */
      path?: string;
    };

/**
 * Host-only description of an input mismatch, given to
 * `replay.onStepMismatch`.
 *
 * @remarks
 * It holds lengths, one window and a structural path built from a fixed
 * list of field names. It never holds input text, chunk digests or the
 * canonical form.
 */
export interface WorkflowStepMismatchHint {
  /** Step whose input changed. */
  stepId: string;
  /** Where the input first differs. */
  diff: WorkflowStepMismatchDiff;
}

/** Chunk size for an input of `length` code units: 256 up to 32 chunks, then the next power of two. */
export function chunkSizeFor(length: number): number {
  let size = MIN_INPUT_CHUNK_SIZE;
  const needed = Math.ceil(length / MAX_INPUT_CHUNKS);
  while (size < needed) size *= 2;
  return size;
}

async function chunkDigest(chunk: string): Promise<string> {
  // `sha256:` plus 64 hex; the first 48 bits are kept.
  const digest = await sha256Digest(chunk);
  const hex = digest.slice(digest.indexOf(":") + 1);
  return hex.slice(0, INPUT_CHUNK_DIGEST_LENGTH);
}

async function chunkDigests(
  canonical: string,
  chunkSize: number,
): Promise<string[]> {
  const parts: Promise<string>[] = [];
  for (let start = 0; start < canonical.length; start += chunkSize) {
    parts.push(chunkDigest(canonical.slice(start, start + chunkSize)));
  }
  return Promise.all(parts);
}

/**
 * Fingerprint of a canonical step input.
 *
 * @remarks
 * A single-chunk input stores its length only: one chunk's digest is a
 * truncation of the input hash the step already stores, so it adds nothing.
 *
 * @param canonical - The canonical JSON form of the step input.
 * @returns The length and, for more than one chunk, the chunk digests.
 */
export async function fingerprintCanonicalInput(
  canonical: string,
): Promise<WorkflowInputFingerprint> {
  const length = canonical.length;
  const chunkSize = chunkSizeFor(length);
  if (length <= chunkSize) return { inputLength: length };
  return {
    inputLength: length,
    inputDigest: {
      chunkSize,
      chunks: await chunkDigests(canonical, chunkSize),
    },
  };
}

/**
 * Compares a saved fingerprint with the current canonical input.
 *
 * @param saved - The saved `inputLength` and `inputDigest`, when present.
 * @param canonical - The current canonical input.
 * @param options - `enabled`: whether the fingerprint option is on now;
 * @returns The window where the inputs first differ, or why there is none.
 */
export async function diffCanonicalInput(
  saved: Partial<WorkflowInputFingerprint>,
  canonical: string,
  options: { enabled: boolean },
): Promise<WorkflowStepMismatchDiff> {
  const savedLength = saved.inputLength;
  if (savedLength === undefined) {
    return {
      available: false,
      reason: options.enabled ? "not-recorded" : "disabled",
    };
  }
  const length = canonical.length;
  const digest: WorkflowCheckpointStepInputDigestV1 | undefined =
    saved.inputDigest;
  if (digest === undefined) {
    return available(savedLength, length, undefined, 0, length, canonical);
  }
  const { chunkSize, chunks } = digest;
  const current = await chunkDigests(canonical, chunkSize);
  const common = Math.min(chunks.length, current.length);
  let index = 0;
  while (index < common && chunks[index] === current[index]) index++;
  if (index === chunks.length && index === current.length) {
    return { available: false, reason: "inconclusive" };
  }
  const start = Math.min(index * chunkSize, length);
  const end = Math.min(start + chunkSize, length);
  return available(savedLength, length, chunkSize, start, end, canonical);
}

function available(
  savedLength: number,
  length: number,
  chunkSize: number | undefined,
  start: number,
  end: number,
  canonical: string,
): WorkflowStepMismatchDiff {
  const path = inputPathAt(canonical, start);
  return {
    available: true,
    savedLength,
    length,
    ...(chunkSize === undefined ? {} : { chunkSize }),
    firstDifference: { start, end },
    ...(path === undefined ? {} : { path }),
  };
}

/**
 * Field names of ADK `Content` and `Part` that may appear in a path. Any other
 * key is written `?`, so a path never carries a caller-chosen name.
 */
const PATH_KEYS: ReadonlySet<string> = new Set([
  "role",
  "parts",
  "text",
  "thought",
  "inlineData",
  "fileData",
  "functionCall",
  "functionResponse",
  "executableCode",
  "codeExecutionResult",
  "name",
  "args",
  "response",
  "mimeType",
  "fileUri",
  "data",
]);

/**
 * Structural path of the JSON value that contains `offset` in a canonical
 * JSON string, such as `parts[2].text`. Array positions are indexes and object
 * keys come from a fixed allowlist (see {@link PATH_KEYS}), else `?`. A plain
 * string input has the empty path.
 *
 * @param canonical - Canonical JSON text.
 * @param offset - UTF-16 offset into `canonical`.
 * @returns The path, or `undefined` when the offset is outside the text or the text is not JSON. Never throws.
 */
export function inputPathAt(
  canonical: string,
  offset: number,
): string | undefined {
  try {
    if (!Number.isInteger(offset) || offset < 0 || offset >= canonical.length) {
      return undefined;
    }
    return new PathScanner(canonical, offset).run();
  } catch {
    return undefined;
  }
}

class PathScanner {
  #position = 0;

  constructor(
    readonly text: string,
    readonly target: number,
  ) {}

  run(): string | undefined {
    const path = this.value("");
    this.skipWhitespace();
    return this.#position === this.text.length ? path : undefined;
  }

  /** Scans one value starting here; returns the path of the deepest value holding the target, if inside. */
  private value(path: string): string | undefined {
    this.skipWhitespace();
    const start = this.#position;
    const char = this.text[start];
    let inner: string | undefined;
    if (char === "{") inner = this.object(path);
    else if (char === "[") inner = this.array(path);
    else if (char === '"') this.string();
    else this.literal();
    const end = this.#position;
    if (this.target < start || this.target >= end) return undefined;
    return inner ?? path;
  }

  private object(path: string): string | undefined {
    let found: string | undefined;
    this.#position++;
    this.skipWhitespace();
    if (this.text[this.#position] === "}") {
      this.#position++;
      return undefined;
    }
    while (true) {
      this.skipWhitespace();
      const keyStart = this.#position;
      const key = this.string();
      this.skipWhitespace();
      this.expect(":");
      const member = `${path === "" ? "" : `${path}.`}${PATH_KEYS.has(key) ? key : "?"}`;
      const valueStart = this.#position;
      const inner = this.value(member);
      // A target inside the key text names the member itself.
      if (found === undefined) {
        if (this.target >= keyStart && this.target < valueStart) found = member;
        else if (inner !== undefined) found = inner;
      }
      this.skipWhitespace();
      const next = this.text[this.#position++];
      if (next === "}") return found;
      if (next !== ",") throw new Error("bad object");
    }
  }

  private array(path: string): string | undefined {
    let found: string | undefined;
    this.#position++;
    this.skipWhitespace();
    if (this.text[this.#position] === "]") {
      this.#position++;
      return undefined;
    }
    for (let index = 0; ; index++) {
      const inner = this.value(`${path}[${index}]`);
      if (found === undefined && inner !== undefined) found = inner;
      this.skipWhitespace();
      const next = this.text[this.#position++];
      if (next === "]") return found;
      if (next !== ",") throw new Error("bad array");
    }
  }

  /** Reads a JSON string and returns its decoded value. */
  private string(): string {
    const start = this.#position;
    if (this.text[start] !== '"') throw new Error("bad string");
    this.#position++;
    while (this.#position < this.text.length) {
      const char = this.text[this.#position++];
      if (char === "\\") this.#position++;
      else if (char === '"') {
        return JSON.parse(this.text.slice(start, this.#position)) as string;
      }
    }
    throw new Error("unterminated string");
  }

  private literal(): void {
    const start = this.#position;
    while (
      this.#position < this.text.length &&
      !",]} \n\t\r".includes(this.text[this.#position] as string)
    ) {
      this.#position++;
    }
    if (this.#position === start) throw new Error("bad literal");
  }

  private expect(char: string): void {
    if (this.text[this.#position++] !== char) throw new Error("bad json");
  }

  private skipWhitespace(): void {
    while (" \n\t\r".includes(this.text[this.#position] ?? "x")) {
      this.#position++;
    }
  }
}
