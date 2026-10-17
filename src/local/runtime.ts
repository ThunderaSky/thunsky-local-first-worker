/**
 * Local-First Worker — Runtime Glue
 *
 * Wires config, task store, Ollama client, and the sequential runner
 * into a single entrypoint object. This module never touches Conway
 * registration, credits, wallets, or any remote service.
 */

import type { LocalConfig } from "./config.js";
import { loadLocalConfig } from "./config.js";
import { createOllamaClient, type OllamaClient } from "./ollama.js";
import { runTask, type RunnerDeps } from "./runner.js";
import { TaskStore } from "./task-store.js";
import type { LocalTaskRecord } from "./types.js";
import { LocalRuntimeError } from "./types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("local.runtime");

export interface LocalRuntime {
  cfg: LocalConfig;
  store: TaskStore;
  ollama: OllamaClient;
  /** Create a task from a prompt and run it to a terminal state. */
  run(prompt: string, signal?: AbortSignal): Promise<LocalTaskRecord>;
  /** Re-run an existing task record by id. */
  rerun(taskId: string, signal?: AbortSignal): Promise<LocalTaskRecord>;
  /** Verify the Ollama server is reachable and the model exists. */
  preflight(signal?: AbortSignal): Promise<string[]>;
}

export function createLocalRuntime(
  overrides: Partial<LocalConfig> = {},
  deps?: { ollama?: OllamaClient },
): LocalRuntime {
  const cfg = loadLocalConfig(process.env, overrides);
  const store = new TaskStore(cfg.tasksDir);
  const ollama = deps?.ollama ?? createOllamaClient(cfg.ollamaBaseUrl);
  const runnerDeps: RunnerDeps = { cfg, ollama, store };

  return {
    cfg,
    store,
    ollama,

    async run(prompt: string, signal?: AbortSignal): Promise<LocalTaskRecord> {
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new LocalRuntimeError("INVALID_TASK", "Prompt must be a non-empty string");
      }
      const record = store.create(prompt.trim());
      logger.info(`Task ${record.id} created`, { prompt: record.prompt.slice(0, 120) });
      return runTask(record.id, runnerDeps, signal);
    },

    async rerun(taskId: string, signal?: AbortSignal): Promise<LocalTaskRecord> {
      return runTask(taskId, runnerDeps, signal);
    },

    async preflight(signal?: AbortSignal): Promise<string[]> {
      const models = await ollama.listModels(15_000, signal);
      if (!models.includes(cfg.model)) {
        throw new LocalRuntimeError(
          "MODEL_NOT_FOUND",
          `Model "${cfg.model}" not found locally. Available: ${models.join(", ") || "(none)"}`,
          false,
        );
      }
      return models;
    },
  };
}

export { loadLocalConfig } from "./config.js";
export type { LocalConfig } from "./config.js";
export type { LocalTaskRecord } from "./types.js";
