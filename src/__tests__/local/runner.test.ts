/**
 * Local-First Worker — Sequential runner tests
 * Uses a fake Ollama client; no server required.
 * Covers: success path, missing model, retryable failure with recovery,
 * retry exhaustion, non-retryable failure, cancellation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLocalConfig, type LocalConfig } from "../../local/config.js";
import type { OllamaClient, OllamaChatResult } from "../../local/ollama.js";
import { runTask } from "../../local/runner.js";
import { TaskStore } from "../../local/task-store.js";
import { LocalRuntimeError } from "../../local/types.js";

let tmp: string;
let cfg: LocalConfig;
let store: TaskStore;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-runner-"));
  cfg = loadLocalConfig({} as NodeJS.ProcessEnv, {
    workspaceRoot: tmp,
    artifactsDir: path.join(tmp, "artifacts"),
    tasksDir: path.join(tmp, "tasks"),
    model: "fake-model",
    maxAttempts: 2,
    requestTimeoutMs: 5_000,
  });
  store = new TaskStore(cfg.tasksDir);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeOllama(overrides: Partial<OllamaClient> = {}): OllamaClient {
  return {
    listModels: async () => ["fake-model"],
    chat: async (): Promise<OllamaChatResult> => ({
      model: "fake-model",
      content: "Réponse du modèle local.",
      done: true,
    }),
    ...overrides,
  };
}

async function runWith(ollama: OllamaClient, signal?: AbortSignal) {
  const task = store.create("prompt de test");
  return runTask(task.id, { cfg, ollama, store }, signal);
}

describe("runTask", () => {
  it("succeeds end-to-end and writes a verified artifact", async () => {
    const record = await runWith(fakeOllama());
    expect(record.status).toBe("succeeded");
    expect(record.artifactPath).toBeDefined();
    expect(fs.readFileSync(record.artifactPath!, "utf-8")).toBe(
      "Réponse du modèle local.",
    );
    expect(record.steps.map((s) => s.name)).toEqual([
      "ollama.preflight",
      "ollama.chat",
      "verify.output",
      "fs.write",
    ]);
    // Final record persisted on disk.
    expect(store.get(record.id)?.status).toBe("succeeded");
  });

  it("fails with MODEL_NOT_FOUND when the model is absent (no retry)", async () => {
    const record = await runWith(
      fakeOllama({ listModels: async () => ["other-model"] }),
    );
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("MODEL_NOT_FOUND");
    expect(record.attempts).toBe(0);
  });

  it("retries a retryable inference error and then succeeds", async () => {
    let calls = 0;
    const record = await runWith(
      fakeOllama({
        chat: async () => {
          calls++;
          if (calls === 1) {
            throw new LocalRuntimeError("OLLAMA_UNAVAILABLE", "conn refused", true);
          }
          return { model: "fake-model", content: "deuxième essai", done: true };
        },
      }),
    );
    expect(record.status).toBe("succeeded");
    expect(record.attempts).toBe(2);
    const chatSteps = record.steps.filter((s) => s.name === "ollama.chat");
    expect(chatSteps).toHaveLength(2);
    expect(chatSteps[0].ok).toBe(false);
    expect(chatSteps[1].ok).toBe(true);
  });

  it("fails after exhausting attempts on persistent retryable errors", async () => {
    const record = await runWith(
      fakeOllama({
        chat: async () => {
          throw new LocalRuntimeError("TIMEOUT", "timed out", true);
        },
      }),
    );
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("TIMEOUT");
    expect(record.attempts).toBe(2); // maxAttempts
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    const record = await runWith(
      fakeOllama({
        chat: async () => {
          calls++;
          throw new LocalRuntimeError("MALFORMED_RESPONSE", "bad body", false);
        },
      }),
    );
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("MALFORMED_RESPONSE");
    expect(calls).toBe(1);
  });

  it("marks the task cancelled when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const record = await runWith(fakeOllama(), controller.signal);
    expect(record.status).toBe("cancelled");
    expect(record.error?.code).toBe("CANCELLED");
  });

  it("fails with VERIFICATION_FAILED on empty model output", async () => {
    const record = await runWith(
      fakeOllama({
        chat: async () => ({ model: "fake-model", content: "   ", done: true }),
      }),
    );
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("VERIFICATION_FAILED");
    // No artifact should exist for a failed verification.
    expect(record.artifactPath).toBeUndefined();
  });
});
