#!/usr/bin/env node
/**
 * Local-First Worker — CLI
 *
 * Entry point for the Conway-free local worker.
 * Requires only a local Ollama server; no API key, no wallet, no network.
 *
 * Usage:
 *   pnpm local -- run --prompt "..." [--model <tag>] [--max-attempts <n>]
 *   pnpm local -- models
 *   pnpm local -- list
 *   pnpm local -- show <taskId>
 *   pnpm local -- help
 */

import { createLocalRuntime } from "./runtime.js";
import type { LocalConfig } from "./config.js";
import { LocalRuntimeError, type LocalTaskRecord } from "./types.js";
import { createLogger, setGlobalLogLevel } from "../observability/logger.js";

const logger = createLogger("local.cli");

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Drop bare "--" separators — pnpm/npm forward them literally
  // (`pnpm local -- models` would otherwise make "--" the command).
  const cleaned = argv.filter((a) => a !== "--");
  const [command = "help", ...rest] = cleaned;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return { command, flags };
}

function printTask(record: LocalTaskRecord): void {
  console.log(`id:        ${record.id}`);
  console.log(`status:    ${record.status}`);
  console.log(`attempts:  ${record.attempts}`);
  console.log(`created:   ${record.createdAt}`);
  console.log(`updated:   ${record.updatedAt}`);
  if (record.artifactPath) console.log(`artifact:  ${record.artifactPath}`);
  if (record.resultSummary) console.log(`summary:   ${record.resultSummary}`);
  if (record.error) console.log(`error:     [${record.error.code}] ${record.error.message}`);
  console.log(`prompt:    ${record.prompt.slice(0, 200)}`);
  if (record.steps.length > 0) {
    console.log("steps:");
    for (const s of record.steps) {
      console.log(
        `  ${s.index}. [${s.kind}] ${s.name} ${s.ok ? "OK" : "FAIL"} (${s.durationMs}ms) ${s.detail ?? ""}`,
      );
    }
  }
}

function runtimeOverrides(flags: Record<string, string>): Partial<LocalConfig> {
  const overrides: Partial<LocalConfig> = {};
  if (flags.model) overrides.model = flags.model;
  if (flags["max-attempts"]) {
    overrides.maxAttempts = Number.parseInt(flags["max-attempts"], 10);
  }
  if (flags["ollama-url"]) overrides.ollamaBaseUrl = flags["ollama-url"];
  if (flags.workspace) overrides.workspaceRoot = flags.workspace;
  return overrides;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags["log-level"] === "debug") setGlobalLogLevel("debug");

  // SIGINT becomes an explicit cancellation of the in-flight task.
  const controller = new AbortController();
  const onSigint = () => {
    console.error("\nCancellation requested — finishing safely...");
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    switch (command) {
      case "run": {
        const prompt = flags.prompt;
        if (!prompt) {
          console.error("Error: run requires --prompt \"...\"");
          return 1;
        }
        const runtime = createLocalRuntime(runtimeOverrides(flags));
        console.log(
          `Local worker: model=${runtime.cfg.model} ollama=${runtime.cfg.ollamaBaseUrl}\n` +
            `workspace=${runtime.cfg.workspaceRoot}\n`,
        );
        const record = await runtime.run(prompt, controller.signal);
        printTask(record);
        if (record.status === "succeeded") {
          console.log(`\nArtifact saved: ${record.artifactPath}`);
          return 0;
        }
        if (record.status === "cancelled") {
          console.error("\nTask cancelled.");
          return 130;
        }
        console.error(`\nTask ${record.status}: [${record.error?.code}] ${record.error?.message}`);
        return 1;
      }

      case "rerun": {
        const id = flags._ ?? process.argv[3];
        if (!id) {
          console.error("Error: rerun requires a task id");
          return 1;
        }
        const runtime = createLocalRuntime(runtimeOverrides(flags));
        const record = await runtime.rerun(id, controller.signal);
        printTask(record);
        return record.status === "succeeded" ? 0 : 1;
      }

      case "models": {
        const runtime = createLocalRuntime(runtimeOverrides(flags));
        const models = await runtime.ollama.listModels(15_000, controller.signal);
        console.log(`Ollama at ${runtime.cfg.ollamaBaseUrl} serves ${models.length} model(s):`);
        for (const m of models) {
          console.log(`  ${m}${m === runtime.cfg.model ? "  <- configured" : ""}`);
        }
        return 0;
      }

      case "list": {
        const runtime = createLocalRuntime(runtimeOverrides(flags));
        const records = runtime.store.list();
        if (records.length === 0) {
          console.log("No tasks recorded yet.");
          return 0;
        }
        for (const r of records) {
          console.log(
            `${r.id}  ${r.status.padEnd(9)}  ${r.updatedAt}  ${r.prompt.slice(0, 60).replace(/\s+/g, " ")}`,
          );
        }
        return 0;
      }

      case "show": {
        const id = flags._ ?? process.argv[3];
        if (!id) {
          console.error("Error: show requires a task id");
          return 1;
        }
        const runtime = createLocalRuntime(runtimeOverrides(flags));
        const record = runtime.store.get(id);
        if (!record) {
          console.error(`Unknown task id: ${id}`);
          return 1;
        }
        printTask(record);
        return 0;
      }

      default: {
        console.log(`Local-First Worker (Conway-free)

Usage:
  local run --prompt "<text>" [--model <tag>] [--max-attempts <n>] [--ollama-url <url>]
  local models
  local list
  local show <taskId>
  local rerun <taskId>

Environment:
  OLLAMA_BASE_URL           Ollama base URL (default http://127.0.0.1:11434)
  LOCAL_MODEL               Model tag (default qwen2.5:0.5b-instruct)
  LOCAL_WORKSPACE_ROOT      Read sandbox root (default cwd)
  LOCAL_ARTIFACTS_DIR       Artifact directory (default <workspace>/local-runtime/artifacts)
  LOCAL_TASKS_DIR           Task record directory (default <workspace>/local-runtime/tasks)
  LOCAL_MAX_ATTEMPTS        Inference attempts incl. retries (default 3)
  LOCAL_REQUEST_TIMEOUT_MS  Per-request timeout (default 120000)`);
        return command === "help" ? 0 : 1;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof LocalRuntimeError) {
      console.error(`[${err.code}] ${err.message}`);
    } else {
      logger.error("Unhandled error", err instanceof Error ? err : new Error(String(err)));
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  });
