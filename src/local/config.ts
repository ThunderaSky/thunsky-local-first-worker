/**
 * Local-First Worker — Configuration
 *
 * All configuration comes from environment variables and CLI flags.
 * Defaults are chosen for a Windows 10 machine with a local Ollama
 * install and no Conway account: nothing here contacts a remote API.
 */

import fs from "node:fs";
import path from "node:path";
import { LocalRuntimeError } from "./types.js";

export interface LocalConfig {
  /** Base URL of the local Ollama server. */
  ollamaBaseUrl: string;
  /** Model tag to use, e.g. "qwen2.5:0.5b-instruct". */
  model: string;
  /** Root directory the worker may read from (sandbox root). */
  workspaceRoot: string;
  /** Directory where artifacts are written (must be inside workspaceRoot). */
  artifactsDir: string;
  /** Directory where task records are persisted. */
  tasksDir: string;
  /** Max inference attempts per task (1 = no retries). */
  maxAttempts: number;
  /** Per-request timeout for Ollama calls. */
  requestTimeoutMs: number;
  /** Upper bound on model output characters accepted by the verifier. */
  maxOutputChars: number;
  /** Sampling temperature. */
  temperature: number;
  /** Cap on output tokens requested from Ollama (num_predict). */
  numPredict: number;
}

export const DEFAULT_MODEL = "qwen2.5:0.5b-instruct";

export function loadLocalConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<LocalConfig> = {},
): LocalConfig {
  const workspaceRoot = path.resolve(
    overrides.workspaceRoot ?? env.LOCAL_WORKSPACE_ROOT ?? process.cwd(),
  );
  const artifactsDir = path.resolve(
    overrides.artifactsDir ??
      env.LOCAL_ARTIFACTS_DIR ??
      path.join(workspaceRoot, "local-runtime", "artifacts"),
  );
  const tasksDir = path.resolve(
    overrides.tasksDir ??
      env.LOCAL_TASKS_DIR ??
      path.join(workspaceRoot, "local-runtime", "tasks"),
  );

  // Artifacts must live inside the workspace sandbox — this is a hard rule,
  // not a preference. Violating it is a configuration bug we refuse to run.
  if (!isInside(artifactsDir, workspaceRoot)) {
    throw new LocalRuntimeError(
      "POLICY_DENIED",
      `artifactsDir (${artifactsDir}) must be inside workspaceRoot (${workspaceRoot})`,
    );
  }

  const config: LocalConfig = {
    ollamaBaseUrl: (
      overrides.ollamaBaseUrl ??
      env.OLLAMA_BASE_URL ??
      "http://127.0.0.1:11434"
    ).replace(/\/+$/, ""),
    model: overrides.model ?? env.LOCAL_MODEL ?? DEFAULT_MODEL,
    workspaceRoot,
    artifactsDir,
    tasksDir,
    maxAttempts: clampInt(overrides.maxAttempts ?? env.LOCAL_MAX_ATTEMPTS, 1, 10, 3),
    requestTimeoutMs: clampInt(
      overrides.requestTimeoutMs ?? env.LOCAL_REQUEST_TIMEOUT_MS,
      1_000,
      600_000,
      120_000,
    ),
    maxOutputChars: clampInt(
      overrides.maxOutputChars ?? env.LOCAL_MAX_OUTPUT_CHARS,
      256,
      1_000_000,
      200_000,
    ),
    temperature: clampNumber(overrides.temperature ?? env.LOCAL_TEMPERATURE, 0, 2, 0.2),
    numPredict: clampInt(overrides.numPredict ?? env.LOCAL_NUM_PREDICT, 16, 32_768, 1024),
  };

  ensureDir(config.tasksDir);
  ensureDir(config.artifactsDir);
  return config;
}

/** True if `target` is `root` itself or below it. */
export function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
