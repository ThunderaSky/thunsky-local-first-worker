/**
 * Local-First Worker — Ollama Inference Adapter
 *
 * Minimal, dependency-free client for a local Ollama server.
 * Speaks the native /api/tags and /api/chat endpoints via fetch.
 *
 * Error mapping:
 *   - fetch failure / connection refused  -> OLLAMA_UNAVAILABLE (retryable)
 *   - request exceeded timeout            -> TIMEOUT (retryable)
 *   - model missing or pull required      -> MODEL_NOT_FOUND (not retryable)
 *   - non-JSON / shapeless response       -> MALFORMED_RESPONSE (not retryable)
 *   - abort                               -> CANCELLED (not retryable)
 */

import { LocalRuntimeError } from "./types.js";

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatOptions {
  model: string;
  temperature?: number;
  numPredict?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OllamaChatResult {
  model: string;
  content: string;
  done: boolean;
  evalCount?: number;
  promptEvalCount?: number;
}

export interface OllamaClient {
  /** List local model tags, e.g. ["qwen2.5:0.5b-instruct"]. */
  listModels(timeoutMs?: number, signal?: AbortSignal): Promise<string[]>;
  /** Single non-streaming chat completion. */
  chat(messages: OllamaChatMessage[], options: OllamaChatOptions): Promise<OllamaChatResult>;
}

export function createOllamaClient(baseUrl: string): OllamaClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function requestJson(
    pathname: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<any> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let resp: Response;
    try {
      resp = await fetch(`${root}${pathname}`, { ...init, signal: combined });
    } catch (err) {
      if (signal?.aborted) {
        throw new LocalRuntimeError("CANCELLED", "Request cancelled", false);
      }
      const cause = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new LocalRuntimeError(
          "TIMEOUT",
          `Ollama request timed out after ${timeoutMs}ms`,
          true,
        );
      }
      throw new LocalRuntimeError(
        "OLLAMA_UNAVAILABLE",
        `Ollama unreachable at ${root}: ${cause}`,
        true,
      );
    }

    const text = await resp.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new LocalRuntimeError(
        "MALFORMED_RESPONSE",
        `Ollama returned non-JSON (status ${resp.status}): ${text.slice(0, 200)}`,
        false,
      );
    }

    // Ollama reports errors in the body with 200 or 4xx; both carry `error`.
    if (!resp.ok || (body && typeof body.error === "string" && body.error)) {
      const msg = (body?.error ?? `HTTP ${resp.status}`) as string;
      if (/not found|no such model|pull/i.test(msg)) {
        throw new LocalRuntimeError(
          "MODEL_NOT_FOUND",
          `Model unavailable on local Ollama: ${msg}`,
          false,
        );
      }
      throw new LocalRuntimeError(
        "OLLAMA_UNAVAILABLE",
        `Ollama error (status ${resp.status}): ${msg}`,
        true,
      );
    }
    return body;
  }

  return {
    async listModels(timeoutMs = 15_000, signal): Promise<string[]> {
      const body = await requestJson("/api/tags", { method: "GET" }, timeoutMs, signal);
      if (!body || !Array.isArray(body.models)) {
        throw new LocalRuntimeError(
          "MALFORMED_RESPONSE",
          "Ollama /api/tags response has no models array",
          false,
        );
      }
      return body.models
        .map((m: any) => String(m?.name ?? m?.model ?? ""))
        .filter((n: string) => n.length > 0);
    },

    async chat(
      messages: OllamaChatMessage[],
      options: OllamaChatOptions,
    ): Promise<OllamaChatResult> {
      const payload = {
        model: options.model,
        messages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.2,
          num_predict: options.numPredict ?? 1024,
        },
      };
      const body = await requestJson(
        "/api/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        options.timeoutMs ?? 120_000,
        options.signal,
      );

      const content = body?.message?.content;
      if (typeof content !== "string" || body?.done !== true) {
        throw new LocalRuntimeError(
          "MALFORMED_RESPONSE",
          `Ollama /api/chat response missing message.content or done flag`,
          false,
        );
      }
      return {
        model: String(body.model ?? options.model),
        content,
        done: true,
        evalCount: typeof body.eval_count === "number" ? body.eval_count : undefined,
        promptEvalCount:
          typeof body.prompt_eval_count === "number" ? body.prompt_eval_count : undefined,
      };
    },
  };
}
