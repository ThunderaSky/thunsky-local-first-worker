/**
 * Local-First Worker — Public API
 *
 * Import surface for the Conway-free local runtime. Nothing exported here
 * initializes Conway registration, wallets, credits, or remote execution.
 */

export { createLocalRuntime } from "./runtime.js";
export type { LocalRuntime } from "./runtime.js";
export { loadLocalConfig, isInside, DEFAULT_MODEL } from "./config.js";
export type { LocalConfig } from "./config.js";
export { createOllamaClient } from "./ollama.js";
export type { OllamaClient, OllamaChatMessage, OllamaChatResult } from "./ollama.js";
export { TaskStore } from "./task-store.js";
export { runTask } from "./runner.js";
export { evaluateToolRequest, ALLOWED_TOOLS } from "./policy.js";
export type { LocalToolName, LocalPolicyDecision } from "./policy.js";
export { authorizeAndRun } from "./tools.js";
export { verifyOutput, writeVerifiedArtifact } from "./verifier.js";
export { LocalRuntimeError, toTaskError } from "./types.js";
export type {
  LocalTaskRecord,
  LocalTaskStep,
  LocalTaskError,
  LocalErrorCode,
  TaskStatus,
} from "./types.js";
