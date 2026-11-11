/**
 * Optional per-step fields that let a later turn report what changed on a
 * replayed step: the model the step's agent requested, a fingerprint of the
 * canonical step input, and the host acceptances applied to it. Every field may be absent (older checkpoints, or the
 * fingerprint turned off), and an absent field means "not recorded".
 */

import {
  isStepAcceptances,
  type WorkflowCheckpointStepAcceptanceV1,
} from "./replay-acceptance.js";

/** Longest stored model id. */
const MAX_MODEL_ID_LENGTH = 256;
/** Smallest chunk of the input fingerprint, in UTF-16 code units. */
export const MIN_INPUT_CHUNK_SIZE = 256;
/** Most chunks the input fingerprint stores. */
export const MAX_INPUT_CHUNKS = 32;
/** Hex characters kept of each chunk digest (48 bits). */
export const INPUT_CHUNK_DIGEST_LENGTH = 12;

const CHUNK_DIGEST = /^[0-9a-f]{12}$/;

/** Model a step's agent requested when its latest attempt started. */
export interface WorkflowCheckpointStepModelV1 {
  /** Requested model id; absent when the agent named none or it could not be read. */
  requested?: string;
}

/** Chunked fingerprint of a canonical step input. */
export interface WorkflowCheckpointStepInputDigestV1 {
  /** UTF-16 code units per chunk: a power of two, at least 256. */
  chunkSize: number;
  /** Two to 32 digests of 12 lowercase hex characters, in order. */
  chunks: string[];
}

/** The optional step fields this module describes. */
export interface WorkflowCheckpointStepRecordV1 {
  /**
   * Model the step's agent requested at the start of its latest attempt.
   * Absent: not recorded. `{}`: recorded, the agent had no readable model.
   */
  model?: WorkflowCheckpointStepModelV1;
  /** UTF-16 length of the canonical step input; written while the fingerprint is on. */
  inputLength?: number;
  /**
   * Chunked fingerprint of the canonical step input. Absent when it was not
   * recorded, is turned off, or the input fits one chunk.
   */
  inputDigest?: WorkflowCheckpointStepInputDigestV1;
  /**
   * Host acceptances applied to this step, oldest first, at most 32; only on a
   * `completed` step. An audit record, not authority: after an accepted input
   * change, `inputHash` is the accepted input's hash and the entry keeps the
   * old one; an accepted model change leaves `model.requested` as it ran.
   */
  acceptances?: WorkflowCheckpointStepAcceptanceV1[];
}

/**
 * Whether the optional record fields of a stored step are well formed.
 *
 * @internal
 */
export function isStepRecordFields(value: Record<string, unknown>): boolean {
  const { model, inputLength, inputDigest, acceptances } = value;
  if (model !== undefined && !isModel(model)) return false;
  if (
    acceptances !== undefined &&
    !isStepAcceptances(acceptances, value.status)
  ) {
    return false;
  }
  if (inputLength !== undefined && !isLength(inputLength)) return false;
  if (inputDigest !== undefined) {
    return isLength(inputLength) && isInputDigest(inputDigest, inputLength);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isModel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
  const { requested } = value;
  return (
    keys.length === 1 &&
    keys[0] === "requested" &&
    typeof requested === "string" &&
    requested.length > 0 &&
    requested.length <= MAX_MODEL_ID_LENGTH
  );
}

function isLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isInputDigest(value: unknown, inputLength: number): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const { chunkSize, chunks } = value;
  if (
    typeof chunkSize !== "number" ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < MIN_INPUT_CHUNK_SIZE ||
    !Number.isInteger(Math.log2(chunkSize)) ||
    inputLength <= chunkSize ||
    !Array.isArray(chunks) ||
    chunks.length < 2 ||
    chunks.length > MAX_INPUT_CHUNKS ||
    chunks.length !== Math.ceil(inputLength / chunkSize)
  ) {
    return false;
  }
  return chunks.every(
    (chunk) => typeof chunk === "string" && CHUNK_DIGEST.test(chunk),
  );
}
