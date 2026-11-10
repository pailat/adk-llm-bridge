/**
 * Error codes of {@link WorkflowControlPlaneError}.
 *
 * @remarks
 * - `WORKFLOW_CONTROL_INVALID_REQUEST`: the envelope or a payload is invalid.
 * - `WORKFLOW_CONTROL_UNAUTHORIZED`: the operation needs a host-authenticated
 *   actor and none was passed, or the actor is bound to another execution or
 *   task than the one the request targets.
 * - `WORKFLOW_CONTROL_UNKNOWN_OPERATION`: the operation is not known.
 * - `WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE`: the control plane was built
 *   without the service the operation needs.
 * - `WORKFLOW_CONTROL_INVALID_RESULT`: a host-injected controller returned a
 *   value that is not JSON or has the wrong shape for the operation.
 */
export type WorkflowControlPlaneErrorCode =
  | "WORKFLOW_CONTROL_INVALID_REQUEST"
  | "WORKFLOW_CONTROL_UNAUTHORIZED"
  | "WORKFLOW_CONTROL_UNKNOWN_OPERATION"
  | "WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE"
  | "WORKFLOW_CONTROL_INVALID_RESULT";

/** Error thrown by {@link WorkflowControlPlane}, with a typed `code`. */
export class WorkflowControlPlaneError extends Error {
  /** Machine-readable failure class. */
  readonly code: WorkflowControlPlaneErrorCode;

  /**
   * Creates a control-plane error.
   *
   * @param code - Machine-readable failure class.
   * @param message - Human-readable message.
   */
  constructor(code: WorkflowControlPlaneErrorCode, message: string) {
    super(message);
    this.name = "WorkflowControlPlaneError";
    this.code = code;
  }
}

/**
 * Throws the control plane's invalid-request error.
 *
 * @param message - Error message.
 * @throws {@link WorkflowControlPlaneError} with code
 * `WORKFLOW_CONTROL_INVALID_REQUEST`, always.
 * @internal
 */
export function invalid(message: string): never {
  throw new WorkflowControlPlaneError(
    "WORKFLOW_CONTROL_INVALID_REQUEST",
    message,
  );
}

/**
 * Throws the control plane's unauthorized error.
 *
 * @param message - Error message.
 * @throws {@link WorkflowControlPlaneError} with code
 * `WORKFLOW_CONTROL_UNAUTHORIZED`, always.
 * @internal
 */
export function unauthorized(message: string): never {
  throw new WorkflowControlPlaneError("WORKFLOW_CONTROL_UNAUTHORIZED", message);
}
