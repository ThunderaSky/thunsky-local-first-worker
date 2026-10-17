/**
 * Local-First Worker — Sequential Task Runner
 *
 * Runs one task at a time, in order, with:
 *   - bounded steps (a task can never exceed `maxSteps` recorded steps)
 *   - bounded retries with linear backoff (only for retryable errors)
 *   - explicit cancellation via AbortSignal (SIGINT in the CLI)
 *   - safe failure: every terminal state is persisted to the task store
 *
 * The task pipeline is deliberately simple for v1:
 *   1. preflight  — confirm the configured model exists locally
 *   2. inference  — one Ollama chat call (retried on retryable errors)
 *   3. verify     — static output checks
 *   4. artifact   — write + round-trip verification (policy-gated)
 */

import path from "node:path";
import type { LocalConfig } from "./config.js";
import type { OllamaClient } from "./ollama.js";
import type { TaskStore } from "./task-store.js";
import { authorizeAndRun } from "./tools.js";
import { verifyOutput, writeVerifiedArtifact } from "./verifier.js";
import {
  LocalRuntimeError,
  toTaskError,
  type LocalTaskRecord,
} from "./types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("local.runner");

const MAX_STEPS = 16;
const RETRY_BACKOFF_MS = 1_500;
const SYSTEM_PROMPT =
  "You are a helpful local worker. Answer concisely and completely. " +
  "Do not invent file paths or claim to have performed actions you cannot perform.";

export interface RunnerDeps {
  cfg: LocalConfig;
  ollama: OllamaClient;
  store: TaskStore;
}

function pushStep(
  record: LocalTaskRecord,
  store: TaskStore,
  step: Omit<LocalTaskRecord["steps"][number], "index" | "startedAt" | "durationMs"> & {
    startedAt: string;
    durationMs: number;
  },
): void {
  if (record.steps.length >= MAX_STEPS) {
    throw new LocalRuntimeError("MAX_STEPS_EXCEEDED", `Task exceeded ${MAX_STEPS} steps`);
  }
  record.steps.push({ index: record.steps.length, ...step });
  store.save(record);
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LocalRuntimeError("CANCELLED", "Task cancelled", false);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LocalRuntimeError("CANCELLED", "Task cancelled", false));
    };
    if (signal?.aborted) {
      clearTimeout(t);
      reject(new LocalRuntimeError("CANCELLED", "Task cancelled", false));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run a task to a terminal state. Always persists the final record. */
export async function runTask(
  taskId: string,
  deps: RunnerDeps,
  signal?: AbortSignal,
): Promise<LocalTaskRecord> {
  const { cfg, ollama, store } = deps;
  const record = store.get(taskId);
  if (!record) {
    throw new LocalRuntimeError("INVALID_TASK", `Unknown task id: ${taskId}`);
  }

  record.status = "running";
  store.save(record);

  try {
    checkCancelled(signal);

    // ── 1. Preflight: model must exist on the local Ollama ──────────────
    let preflightStart = Date.now();
    // Allow a slow-but-alive local server time to respond under memory
    // pressure (observed up to 40s on a 4 GB machine); connection refused
    // still fails fast regardless of this cap.
    const models = await ollama.listModels(15_000, signal);
    if (!models.includes(cfg.model)) {
      throw new LocalRuntimeError(
        "MODEL_NOT_FOUND",
        `Model "${cfg.model}" not found locally. Available: ${models.join(", ") || "(none)"}`,
        false,
      );
    }
    pushStep(record, store, {
      kind: "inference",
      name: "ollama.preflight",
      ok: true,
      detail: `model ${cfg.model} available`,
      startedAt: new Date(preflightStart).toISOString(),
      durationMs: Date.now() - preflightStart,
    });

    // ── 2. Inference: bounded attempts, retry only retryable errors ─────
    let content = "";
    let lastError: unknown;
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      checkCancelled(signal);
      record.attempts = attempt;
      store.save(record);
      const start = Date.now();
      try {
        const result = await ollama.chat(
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: record.prompt },
          ],
          {
            model: cfg.model,
            temperature: cfg.temperature,
            numPredict: cfg.numPredict,
            timeoutMs: cfg.requestTimeoutMs,
            signal,
          },
        );
        content = result.content;
        pushStep(record, store, {
          kind: "inference",
          name: "ollama.chat",
          ok: true,
          detail: `attempt ${attempt}/${cfg.maxAttempts}, ${result.evalCount ?? "?"} eval tokens`,
          startedAt: new Date(start).toISOString(),
          durationMs: Date.now() - start,
        });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        const taskErr = toTaskError(err);
        pushStep(record, store, {
          kind: "inference",
          name: "ollama.chat",
          ok: false,
          detail: `attempt ${attempt}/${cfg.maxAttempts} failed [${taskErr.code}]: ${taskErr.message}`,
          startedAt: new Date(start).toISOString(),
          durationMs: Date.now() - start,
        });
        if (!taskErr.retryable || attempt >= cfg.maxAttempts) break;
        logger.warn(`Retryable inference error (attempt ${attempt}): ${taskErr.message}`);
        await sleep(RETRY_BACKOFF_MS * attempt, signal);
      }
    }
    if (lastError) throw lastError;

    // ── 3. Verify output statically ─────────────────────────────────────
    checkCancelled(signal);
    const verification = verifyOutput(content, cfg);
    pushStep(record, store, {
      kind: "tool",
      name: "verify.output",
      ok: verification.ok,
      detail: verification.ok ? "output verified" : verification.problems.join("; "),
      startedAt: new Date().toISOString(),
      durationMs: 0,
    });
    if (!verification.ok) {
      throw new LocalRuntimeError(
        "VERIFICATION_FAILED",
        `Output verification failed: ${verification.problems.join("; ")}`,
        false,
      );
    }

    // ── 4. Persist artifact through the policy gateway ──────────────────
    const artifactName = `${record.id}.md`;
    const toolStart = Date.now();
    const toolResult = authorizeAndRun(
      {
        tool: "fs.write",
        args: { path: artifactName, content },
      },
      cfg,
    );
    pushStep(record, store, {
      kind: "tool",
      name: "fs.write",
      ok: toolResult.ok,
      detail: toolResult.ok ? toolResult.text : `Policy denied: ${toolResult.decision.reason}`,
      startedAt: new Date(toolStart).toISOString(),
      durationMs: Date.now() - toolStart,
    });
    if (!toolResult.ok || !toolResult.decision.resolvedPath) {
      throw new LocalRuntimeError(
        "POLICY_DENIED",
        `Artifact write denied: ${toolResult.decision.reason}`,
        false,
      );
    }

    writeVerifiedArtifact(toolResult.decision.resolvedPath, content, cfg);

    record.artifactPath = toolResult.decision.resolvedPath;
    record.resultSummary = content.slice(0, 160).replace(/\s+/g, " ").trim();
    record.status = "succeeded";
    store.save(record);
    return record;
  } catch (err) {
    const taskErr = toTaskError(err);
    record.error = taskErr;
    record.status = taskErr.code === "CANCELLED" ? "cancelled" : "failed";
    store.save(record);
    return record;
  }
}

/** Resolve the artifact path for a successful task (helper for CLI). */
export function artifactFor(record: LocalTaskRecord): string | undefined {
  return record.artifactPath ? path.normalize(record.artifactPath) : undefined;
}
