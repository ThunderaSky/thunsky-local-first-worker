/**
 * Local-First Worker — Ollama adapter tests
 * All fetch calls are mocked; no Ollama server required.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaClient } from "../../local/ollama.js";
import { LocalRuntimeError } from "../../local/types.js";

const BASE = "http://127.0.0.1:11434";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOllamaClient", () => {
  it("chat() returns content from a valid response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({
        model: "qwen2.5:0.5b-instruct",
        message: { role: "assistant", content: "Bonjour!" },
        done: true,
        eval_count: 42,
        prompt_eval_count: 10,
      }),
    ));
    const client = createOllamaClient(BASE);
    const result = await client.chat([{ role: "user", content: "hi" }], {
      model: "qwen2.5:0.5b-instruct",
    });
    expect(result.content).toBe("Bonjour!");
    expect(result.evalCount).toBe(42);
  });

  it("chat() maps connection failure to OLLAMA_UNAVAILABLE (retryable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const client = createOllamaClient(BASE);
    const err = await client
      .chat([{ role: "user", content: "hi" }], { model: "x" })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    expect(err.code).toBe("OLLAMA_UNAVAILABLE");
    expect(err.retryable).toBe(true);
  });

  it("chat() maps 'model not found' to MODEL_NOT_FOUND (not retryable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: "model 'nope' not found, try pulling it first" }, 404),
    ));
    const client = createOllamaClient(BASE);
    const err = await client
      .chat([{ role: "user", content: "hi" }], { model: "nope" })
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe("MODEL_NOT_FOUND");
    expect(err.retryable).toBe(false);
  });

  it("chat() maps non-JSON body to MALFORMED_RESPONSE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html>oops</html>", { status: 200 }),
    ));
    const client = createOllamaClient(BASE);
    const err = await client
      .chat([{ role: "user", content: "hi" }], { model: "x" })
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe("MALFORMED_RESPONSE");
    expect(err.retryable).toBe(false);
  });

  it("chat() maps missing message.content to MALFORMED_RESPONSE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ model: "x", done: true, message: { role: "assistant" } }),
    ));
    const client = createOllamaClient(BASE);
    const err = await client
      .chat([{ role: "user", content: "hi" }], { model: "x" })
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe("MALFORMED_RESPONSE");
  });

  it("chat() respects an already-aborted signal as CANCELLED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          const e = new Error("This operation was aborted");
          e.name = "AbortError";
          throw e;
        }
        return jsonResponse({});
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const client = createOllamaClient(BASE);
    const err = await client
      .chat([{ role: "user", content: "hi" }], {
        model: "x",
        signal: controller.signal,
      })
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe("CANCELLED");
  });

  it("listModels() returns model tags", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ models: [{ name: "qwen2.5:0.5b-instruct" }, { model: "other" }] }),
    ));
    const client = createOllamaClient(BASE);
    const models = await client.listModels();
    expect(models).toEqual(["qwen2.5:0.5b-instruct", "other"]);
  });

  it("listModels() rejects a shapeless payload as MALFORMED_RESPONSE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ unexpected: true })));
    const client = createOllamaClient(BASE);
    const err = await client.listModels().then(() => null).catch((e) => e);
    expect(err.code).toBe("MALFORMED_RESPONSE");
  });

  it("sends stream:false and options in the chat payload", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ model: "m", message: { content: "ok" }, done: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createOllamaClient(BASE);
    await client.chat([{ role: "user", content: "hi" }], {
      model: "m",
      temperature: 0.1,
      numPredict: 64,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/chat`);
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.1);
    expect(body.options.num_predict).toBe(64);
  });
});
