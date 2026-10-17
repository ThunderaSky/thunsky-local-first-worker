/**
 * Local-First Worker — Core Types
 *
 * Task records, statuses, and typed errors for the local runtime.
 * This module has NO Conway dependencies: no wallets, credits, or remote APIs.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface LocalTaskError {
  code: LocalErrorCode;
  message: string;
  retryable: boolean;
}

/** One recorded step of a task run (inference call or tool execution). */
export interface LocalTaskStep {
  index: number;
  kind: "inference" | "tool";
  name: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  detail?: string;
}

/** Persistent record for a local task. One JSON file per task. */
export interface LocalTaskRecord {
  id: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** Number of inference attempts made (retries increment this). */
  attempts: number;
  /** Bounded, ordered execution steps. */
  steps: LocalTaskStep[];
  /** Absolute path of the artifact written on success. */
  artifactPath?: string;
  /** Short, human-readable summary of the model output. */
  resultSummary?: string;
  error?: LocalTaskError;
}

export type LocalErrorCode =
  | "OLLAMA_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "MALFORMED_RESPONSE"
  | "TIMEOUT"
  | "CANCELLED"
  | "POLICY_DENIED"
  | "VERIFICATION_FAILED"
  | "MAX_STEPS_EXCEEDED"
  | "INVALID_TASK"
  | "INTERNAL";

/**
 * Typed error for the local runtime.
 * `retryable` drives the runner's retry policy; policy denials and
 * malformed responses are never retried.
 */
export class LocalRuntimeError extends Error {
  readonly code: LocalErrorCode;
  readonly retryable: boolean;

  constructor(code: LocalErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "LocalRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function toTaskError(err: unknown): LocalTaskError {
  if (err instanceof LocalRuntimeError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL", message, retryable: false };
}
