/**
 * Local-First Worker — Repeatable Smoke Test
 *
 * Exercises the Conway-free local runtime end to end and prints a concise
 * pass/fail report with a meaningful process exit code. It uses the real
 * runtime, policy gateway, verifier, and task store — never a re-implementation.
 * No Conway credentials are read or required, and there is no cloud fallback:
 * if the configured local model is missing we report an environmental blocker
 * instead of silently switching models.
 *
 * Offline checks (always run; no Ollama server required):
 *   1. config:       artifact/task dirs resolve inside the workspace sandbox
 *   2. failure path: unreachable Ollama endpoint -> task failed with
 *      OLLAMA_UNAVAILABLE, no artifact written, failure persisted
 *   3. failure path: missing model (stubbed model list) -> task failed with
 *      MODEL_NOT_FOUND before any generation call, no artifact written
 *   4. exit status:  running the real CLI against a dead endpoint exits
 *      nonzero and promotes no artifact
 *
 * Live checks (require the configured Ollama endpoint):
 *   5.  endpoint responds
 *   6.  configured model is available before generation is attempted
 *   7.  one bounded prompt through the real runtime reaches "succeeded"
 *   8.  artifact exists, is nonempty, and is inside the artifacts dir
 *   9.  task record persisted on disk and accurately reflects the outcome
 *   10. failure path: a model missing from the real endpoint fails before
 *       generation, with 0 attempts and no artifact promotion
 *   11. exit status: the CLI run with a missing model exits nonzero
 *
 * Usage:
 *   pnpm local:smoke                 offline + live checks
 *   pnpm local:smoke -- --offline    offline checks only (no Ollama needed)
 *   pnpm local:smoke -- --help
 *
 * Exit codes:
 *   0  every executed check passed (in --offline mode: live checks were
 *      explicitly not requested)
 *   1  at least one check failed
 *   2  environmental blocker: live checks could not run (Ollama unreachable
 *      or the configured model is not pulled). Not a pass.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isInside, loadLocalConfig, type LocalConfig } from "./config.js";
import { createLocalRuntime } from "./runtime.js";
import type { OllamaClient } from "./ollama.js";
import { LocalRuntimeError, type LocalTaskRecord } from "./types.js";
import {
  StructuredLogger,
  setGlobalLogLevel,
} from "../observability/logger.js";

// ─── Constants and small helpers ─────────────────────────────────────────

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SELF_DIR, "..", "..");
// Work from source when available, fall back to the compiled CLI in dist/.
const CLI_CANDIDATE = path.join(SELF_DIR, "cli.ts");
const CLI_PATH = fs.existsSync(CLI_CANDIDATE)
  ? CLI_CANDIDATE
  : path.join(SELF_DIR, "cli.js");

/** Bounded live prompt: short, no file/network claims, cheap to generate. */
const BOUNDED_PROMPT =
  "Reply with exactly two words and nothing else: SMOKE OK";
/** Prompt used on failure paths — it must never produce an artifact. */
const FAILURE_PROMPT =
  "smoke-test prompt: this run must fail without producing an artifact";
/** A model tag that must never exist locally; nothing is ever pulled. */
const MISSING_MODEL_TAG = "automaton-smoke-missing-model:latest";

/** Config for smoke runs: fast, bounded, deterministic regardless of env. */
const RUN_OVERRIDES: Partial<LocalConfig> = {
  workspaceRoot: REPO_ROOT,
  maxAttempts: 1,
  requestTimeoutMs: 90_000,
  numPredict: 64,
};

type CheckMode = "offline" | "live";
type CheckStatus = "pass" | "fail" | "blocked" | "skipped";

interface CheckResult {
  mode: CheckMode;
  name: string;
  status: CheckStatus;
  details: string[];
}

const results: CheckResult[] = [];

function emit(result: CheckResult): void {
  results.push(result);
  const label = result.status.toUpperCase().padEnd(8);
  console.log(`  ${label}${result.mode.padEnd(8)}${result.name}`);
  for (const detail of result.details) {
    for (const line of detail.split(/\r?\n/)) {
      console.log(`${" ".repeat(18)}${line}`);
    }
  }
}

async function check(
  mode: CheckMode,
  name: string,
  fn: () => string | void | Promise<string | void>,
): Promise<boolean> {
  try {
    const detail = await fn();
    emit({ mode, name, status: "pass", details: detail ? [detail] : [] });
    return true;
  } catch (err) {
    emit({ mode, name, status: "fail", details: [errMessage(err)] });
    return false;
  }
}

function markBlocked(mode: CheckMode, name: string, reason: string): void {
  emit({ mode, name, status: "blocked", details: [reason] });
}

function markSkipped(mode: CheckMode, name: string, reason: string): void {
  emit({ mode, name, status: "skipped", details: [reason] });
}

/** Throw when a smoke assertion does not hold. */
function must(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function errMessage(err: unknown): string {
  if (err instanceof LocalRuntimeError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** File names currently in a directory (empty set if it does not exist). */
function filesIn(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set<string>();
  }
}

/** Files that appeared in `dir` since the `before` snapshot was taken. */
function newFiles(before: Set<string>, dir: string): string[] {
  const out: string[] = [];
  for (const f of filesIn(dir)) {
    if (!before.has(f)) out.push(f);
  }
  return out;
}

/** Allocate a loopback port that nothing is listening on (connection refused). */
function getUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close(() => reject(new Error("could not allocate a test port")));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

// ─── Real-CLI child process helper ──────────────────────────────────────

interface CliResult {
  code: number | null;
  output: string;
}

/** Run the actual local CLI as a child process and capture its exit code. */
function runCli(args: string[]): Promise<CliResult> {
  const invocation = CLI_PATH.endsWith(".ts")
    ? { cmd: process.execPath, argv: ["--import", "tsx", CLI_PATH, ...args] }
    : { cmd: process.execPath, argv: [CLI_PATH, ...args] };

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.cmd, invocation.argv, {
      cwd: REPO_ROOT,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI child timed out after 120s"));
    }, 120_000);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function outputTail(output: string, lines = 8): string {
  return output
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join("\n                   ");
}

// ─── Report ─────────────────────────────────────────────────────────────

function printContext(cfg: LocalConfig, offlineOnly: boolean): void {
  console.log(`  mode      : ${offlineOnly ? "offline only (live Ollama checks NOT exercised)" : "offline + live"}`);
  console.log(`  workspace : ${cfg.workspaceRoot}`);
  console.log(`  artifacts : ${cfg.artifactsDir}`);
  console.log(`  tasks     : ${cfg.tasksDir}`);
  console.log(`  ollama    : ${cfg.ollamaBaseUrl}`);
  console.log(`  model     : ${cfg.model}`);
  console.log("-".repeat(76));
}

function finish(): number {
  const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  for (const r of results) counts[r.status]++;

  console.log("-".repeat(76));
  console.log(
    `Summary: ${counts.pass} passed, ${counts.fail} failed, ` +
      `${counts.blocked} blocked, ${counts.skipped} skipped`,
  );

  const offlineOnly = process.argv.includes("--offline");
  let code = 0;
  let verdict: string;
  if (counts.fail > 0) {
    code = 1;
    verdict = `FAIL — ${counts.fail} check(s) failed`;
  } else if (counts.blocked > 0) {
    code = 2;
    verdict =
      `BLOCKED — ${counts.blocked} live check(s) could not run because of ` +
      "the environment (see reasons above). Live verification is INCOMPLETE; " +
      "this is not a passed smoke test.";
  } else if (offlineOnly) {
    verdict =
      "PASS (offline only) — live Ollama checks were not exercised. " +
      "Run `pnpm local:smoke` without --offline for full verification.";
  } else {
    verdict = "PASS — all offline and live checks are green.";
  }
  console.log(`RESULT : ${verdict}`);
  console.log(`Exit   : ${code}`);
  return code;
}

function printUsage(): void {
  console.log(`Local-First Worker smoke test

Usage: pnpm local:smoke [-- --offline]

  (default)   offline checks + live Ollama verification
  --offline   run only the checks that need no Ollama server
  --help      show this help

Exit codes: 0 = all executed checks passed
            1 = at least one check failed
            2 = environmental blocker (Ollama unreachable or configured
                model not pulled); live verification incomplete`);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return 0;
  }
  const offlineOnly = argv.includes("--offline");

  // Keep the report readable: loggers created at module import time captured
  // the "info" default, so route them through a sink that drops info/debug
  // and forwards genuine warnings/errors to stderr, outside the report body.
  setGlobalLogLevel("error");
  StructuredLogger.setSink((entry) => {
    if (entry.level === "warn" || entry.level === "error") {
      process.stderr.write(
        `[smoke] ${entry.level} ${entry.module}: ${entry.message}\n`,
      );
    }
  });

  console.log("Local-First Worker — smoke test");
  console.log("=".repeat(76));

  // ── Config guard: abort immediately if the sandbox layout is broken ──
  let loaded: LocalConfig | undefined;
  let configError: unknown;
  try {
    const c = loadLocalConfig(process.env, { workspaceRoot: REPO_ROOT });
    if (!isInside(c.artifactsDir, c.workspaceRoot)) {
      throw new Error(`artifactsDir escapes workspace: ${c.artifactsDir}`);
    }
    if (!isInside(c.tasksDir, c.workspaceRoot)) {
      throw new Error(`tasksDir escapes workspace: ${c.tasksDir}`);
    }
    loaded = c;
  } catch (err) {
    configError = err;
  }
  if (configError !== undefined || !loaded) {
    emit({
      mode: "offline",
      name: "config: runtime dirs resolve inside the workspace sandbox",
      status: "fail",
      details: [errMessage(configError ?? new Error("config failed to load"))],
    });
    return finish();
  }
  const cfg: LocalConfig = loaded;
  emit({
    mode: "offline",
    name: "config: runtime dirs resolve inside the workspace sandbox",
    status: "pass",
    details: [`artifacts=${cfg.artifactsDir}`, `tasks=${cfg.tasksDir}`],
  });
  printContext(cfg, offlineOnly);

  const baseRt = createLocalRuntime(RUN_OVERRIDES);

  // ══ Offline checks (no Ollama required) ════════════════════════════

  // Pick a port nothing listens on: connecting to it is refused at once,
  // so this simulates a dead Ollama without stopping the real service.
  const deadUrl = `http://127.0.0.1:${await getUnusedPort()}`;

  await check("offline", "failure: unreachable Ollama fails the task safely", async () => {
    const artifactsBefore = filesIn(cfg.artifactsDir);
    const rt = createLocalRuntime({
      ...RUN_OVERRIDES,
      ollamaBaseUrl: deadUrl,
      requestTimeoutMs: 5_000,
    });
    const rec = await rt.run(FAILURE_PROMPT);
    must(rec.status === "failed", `expected "failed", got "${rec.status}"`);
    must(
      rec.error?.code === "OLLAMA_UNAVAILABLE",
      `expected OLLAMA_UNAVAILABLE, got ${rec.error?.code ?? "(none)"}`,
    );
    must(!rec.artifactPath, `failed run set artifactPath=${rec.artifactPath}`);
    must(
      !fs.existsSync(path.resolve(cfg.artifactsDir, `${rec.id}.md`)),
      "failed run wrote an artifact file",
    );
    must(
      newFiles(artifactsBefore, cfg.artifactsDir).length === 0,
      `artifact(s) appeared during failed run: ${newFiles(artifactsBefore, cfg.artifactsDir).join(", ")}`,
    );
    const persisted = rt.store.get(rec.id);
    if (!persisted) throw new Error("task record missing from the store after failure");
    must(persisted.status === "failed", `persisted status=${persisted.status}`);
    must(
      persisted.error?.code === "OLLAMA_UNAVAILABLE",
      `persisted error=${persisted.error?.code ?? "(none)"}`,
    );
    return `task ${rec.id} → failed OLLAMA_UNAVAILABLE via ${deadUrl}; no artifact promoted`;
  });

  await check("offline", "failure: missing model fails before generation", async () => {
    let chatCalls = 0;
    const stub: OllamaClient = {
      listModels: async () => ["stub-model-only"],
      chat: async () => {
        chatCalls++;
        return { model: "stub-model-only", content: "must not happen", done: true };
      },
    };
    const artifactsBefore = filesIn(cfg.artifactsDir);
    const rt = createLocalRuntime(
      { ...RUN_OVERRIDES, model: MISSING_MODEL_TAG },
      { ollama: stub },
    );
    const rec = await rt.run(FAILURE_PROMPT);
    must(rec.status === "failed", `expected "failed", got "${rec.status}"`);
    must(
      rec.error?.code === "MODEL_NOT_FOUND",
      `expected MODEL_NOT_FOUND, got ${rec.error?.code ?? "(none)"}`,
    );
    must(rec.attempts === 0, `generation ran before the model check (attempts=${rec.attempts})`);
    must(chatCalls === 0, "chat() was called even though the model was missing");
    must(!rec.artifactPath, `failed run set artifactPath=${rec.artifactPath}`);
    must(
      !fs.existsSync(path.resolve(cfg.artifactsDir, `${rec.id}.md`)),
      "failed run wrote an artifact file",
    );
    must(
      newFiles(artifactsBefore, cfg.artifactsDir).length === 0,
      "artifact(s) appeared during the failed run",
    );
    const persisted = rt.store.get(rec.id);
    must(persisted?.status === "failed", "persisted record does not reflect the failure");
    must(
      persisted?.error?.code === "MODEL_NOT_FOUND",
      `persisted error=${persisted?.error?.code ?? "(none)"}`,
    );
    return `task ${rec.id} → failed MODEL_NOT_FOUND with 0 attempts; chat() never called; no artifact`;
  });

  await check("offline", "exit code: failed CLI run returns nonzero", async () => {
    const artifactsBefore = filesIn(cfg.artifactsDir);
    const taskIdsBefore = new Set(baseRt.store.list().map((r) => r.id));
    const res = await runCli([
      "run",
      "--workspace", REPO_ROOT,
      "--ollama-url", deadUrl,
      "--max-attempts", "1",
      "--prompt", FAILURE_PROMPT,
    ]);
    if (res.code === 0 || res.code === null) {
      throw new Error(
        `expected nonzero exit, got ${res.code}\n                   CLI output tail: ${outputTail(res.output)}`,
      );
    }
    must(
      res.output.includes("OLLAMA_UNAVAILABLE"),
      `CLI output lacks OLLAMA_UNAVAILABLE\n                   CLI output tail: ${outputTail(res.output)}`,
    );
    const fresh = baseRt.store.list().filter((r) => !taskIdsBefore.has(r.id));
    must(fresh.length === 1, `expected 1 new task record, found ${fresh.length}`);
    const record = fresh[0];
    must(record.status === "failed", `child record status=${record.status}`);
    must(!record.artifactPath, "failed CLI run recorded an artifactPath");
    must(
      newFiles(artifactsBefore, cfg.artifactsDir).length === 0,
      "failed CLI run promoted an artifact",
    );
    return `CLI exit=${res.code}; task ${record.id} persisted failed; no artifact promoted`;
  });

  // ══ Live checks (require the configured Ollama endpoint) ═══════════

  const LIVE_MODELING = "ollama: configured model available before generation";
  const liveNames = [
    "ollama: endpoint responds",
    LIVE_MODELING,
    "run: one bounded prompt reaches the succeeded terminal state",
    "artifact: exists, nonempty, and inside the artifacts dir",
    "record: task persisted on disk and matches the outcome",
    "failure: missing model on the real endpoint fails before generation",
    "exit code: CLI missing-model run returns nonzero",
  ];

  if (offlineOnly) {
    for (const name of liveNames) {
      markSkipped("live", name, "live checks not requested (--offline)");
    }
    return finish();
  }

  let endpointError: unknown;
  let models: string[] = [];
  try {
    models = await baseRt.ollama.listModels(15_000);
  } catch (err) {
    endpointError = err;
  }
  if (endpointError !== undefined) {
    const reason = `environmental blocker: no response from ${cfg.ollamaBaseUrl} — ${errMessage(endpointError)}`;
    markBlocked("live", liveNames[0], reason);
    for (const name of liveNames.slice(1)) markBlocked("live", name, reason);
    return finish();
  }
  emit({
    mode: "live",
    name: liveNames[0],
    status: "pass",
    details: [
      `${cfg.ollamaBaseUrl} serves ${models.length} model(s): ` +
        (models.slice(0, 5).join(", ") || "(none)") +
        (models.length > 5 ? ", …" : ""),
    ],
  });

  // Model gate: confirm availability before attempting any generation.
  if (!models.includes(cfg.model)) {
    const reason =
      `environmental blocker: configured model "${cfg.model}" is not pulled locally ` +
      `(available: ${models.join(", ") || "none"}). The smoke test never downloads models; ` +
      `run \`ollama pull ${cfg.model}\` first.`;
    markBlocked("live", liveNames[1], reason);
    for (const name of [liveNames[2], liveNames[3], liveNames[4]]) {
      markBlocked("live", name, reason);
    }
  } else {
    emit({
      mode: "live",
      name: liveNames[1],
      status: "pass",
      details: [`model "${cfg.model}" is available before generation`],
    });

    let rec: LocalTaskRecord | undefined;
    await check("live", liveNames[2], async () => {
      rec = await baseRt.run(BOUNDED_PROMPT);
      must(
        rec.status === "succeeded",
        `expected terminal state "succeeded", got "${rec.status}"` +
          (rec.error ? ` [${rec.error.code}] ${rec.error.message}` : ""),
      );
      return `task ${rec.id} → succeeded (attempts=${rec.attempts}, steps=${rec.steps.length})`;
    });

    if (rec && rec.status === "succeeded") {
      const done = rec;

      await check("live", liveNames[3], () => {
        const p = done.artifactPath;
        if (!p) throw new Error(`task ${done.id} succeeded without an artifactPath`);
        const abs = path.normalize(p);
        if (!fs.existsSync(abs)) throw new Error(`artifact missing: ${abs}`);
        const size = fs.statSync(abs).size;
        must(size > 0, `artifact is empty: ${abs}`);
        must(
          isInside(abs, cfg.artifactsDir),
          `artifact outside the permitted directory ${cfg.artifactsDir}: ${abs}`,
        );
        return `${abs} (${size} bytes, inside ${cfg.artifactsDir})`;
      });

      await check("live", liveNames[4], () => {
        const fresh = baseRt.store.get(done.id);
        if (!fresh) throw new Error(`task record ${done.id} not found on disk`);
        const problems: string[] = [];
        if (fresh.status !== "succeeded") problems.push(`status=${fresh.status}`);
        if (fresh.artifactPath !== done.artifactPath) problems.push("artifactPath mismatch");
        if (fresh.prompt !== BOUNDED_PROMPT) problems.push("prompt mismatch");
        if (fresh.attempts < 1) problems.push(`attempts=${fresh.attempts}`);
        if (fresh.error) problems.push(`unexpected error ${fresh.error.code}`);
        const expectedSteps = ["ollama.preflight", "ollama.chat", "verify.output", "fs.write"];
        const stepNames = fresh.steps.map((s) => s.name);
        if (stepNames.join(",") !== expectedSteps.join(",")) {
          problems.push(`steps=[${stepNames.join(", ")}]`);
        }
        if (fresh.steps.some((s) => !s.ok)) problems.push("a recorded step failed");
        if (new Date(fresh.updatedAt).getTime() < new Date(fresh.createdAt).getTime()) {
          problems.push("updatedAt < createdAt");
        }
        must(
          problems.length === 0,
          `persisted record does not match the outcome: ${problems.join("; ")}`,
        );
        return `${fresh.id}: status=succeeded, attempts=${fresh.attempts}, ${fresh.steps.length} steps, all ok`;
      });
    } else {
      markSkipped("live", liveNames[3], "bounded run did not succeed");
      markSkipped("live", liveNames[4], "bounded run did not succeed");
    }
  }

  // Failure paths against the real endpoint — preflight fails on the model
  // tag, so no generation happens and Ollama is neither stopped nor damaged.
  await check("live", liveNames[5], async () => {
    const artifactsBefore = filesIn(cfg.artifactsDir);
    const rt = createLocalRuntime({ ...RUN_OVERRIDES, model: MISSING_MODEL_TAG });
    const rec = await rt.run(FAILURE_PROMPT);
    must(rec.status === "failed", `expected "failed", got "${rec.status}"`);
    must(
      rec.error?.code === "MODEL_NOT_FOUND",
      `expected MODEL_NOT_FOUND, got ${rec.error?.code ?? "(none)"}`,
    );
    must(rec.attempts === 0, `generation ran despite the missing model (attempts=${rec.attempts})`);
    must(!rec.artifactPath, `failed run set artifactPath=${rec.artifactPath}`);
    must(
      !fs.existsSync(path.resolve(cfg.artifactsDir, `${rec.id}.md`)),
      "failed run wrote an artifact file",
    );
    must(
      newFiles(artifactsBefore, cfg.artifactsDir).length === 0,
      "artifact(s) appeared during the failed run",
    );
    const persisted = rt.store.get(rec.id);
    must(persisted?.status === "failed", "persisted record does not reflect the failure");
    must(
      persisted?.error?.code === "MODEL_NOT_FOUND",
      `persisted error=${persisted?.error?.code ?? "(none)"}`,
    );
    return `task ${rec.id} → failed MODEL_NOT_FOUND with 0 attempts; no artifact promoted`;
  });

  await check("live", liveNames[6], async () => {
    const artifactsBefore = filesIn(cfg.artifactsDir);
    const taskIdsBefore = new Set(baseRt.store.list().map((r) => r.id));
    const res = await runCli([
      "run",
      "--workspace", REPO_ROOT,
      "--max-attempts", "1",
      "--model", MISSING_MODEL_TAG,
      "--prompt", FAILURE_PROMPT,
    ]);
    if (res.code === 0 || res.code === null) {
      throw new Error(
        `expected nonzero exit, got ${res.code}\n                   CLI output tail: ${outputTail(res.output)}`,
      );
    }
    must(
      res.output.includes("MODEL_NOT_FOUND"),
      `CLI output lacks MODEL_NOT_FOUND\n                   CLI output tail: ${outputTail(res.output)}`,
    );
    const fresh = baseRt.store.list().filter((r) => !taskIdsBefore.has(r.id));
    must(fresh.length === 1, `expected 1 new task record, found ${fresh.length}`);
    const record = fresh[0];
    must(record.status === "failed", `child record status=${record.status}`);
    must(!record.artifactPath, "failed CLI run recorded an artifactPath");
    must(
      newFiles(artifactsBefore, cfg.artifactsDir).length === 0,
      "failed CLI run promoted an artifact",
    );
    return `CLI exit=${res.code}; task ${record.id} persisted failed; no artifact promoted`;
  });

  return finish();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`smoke test crashed: ${errMessage(err)}`);
    process.exitCode = 1;
  });