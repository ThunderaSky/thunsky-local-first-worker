/**
 * Local-First Worker — Restricted Local Tools
 *
 * Small, auditable tool implementations. Each call MUST be authorized by
 * the policy gateway (see `authorizeAndRun`) before touching the disk.
 * No shell, no network, no process execution.
 */

import fs from "node:fs";
import path from "node:path";
import type { LocalConfig } from "./config.js";
import {
  evaluateToolRequest,
  type LocalPolicyDecision,
  type LocalToolRequest,
} from "./policy.js";
import { LocalRuntimeError } from "./types.js";

const MAX_READ_BYTES = 256 * 1024; // refuse to load huge files into the context

export interface LocalToolResult {
  ok: boolean;
  /** Text payload (file contents, listing, or error message). */
  text: string;
  decision: LocalPolicyDecision;
}

/**
 * Evaluate the policy gateway, then execute the tool if allowed.
 * Policy denials are returned (not thrown) so the runner can record them
 * as step details without killing the whole task.
 */
export function authorizeAndRun(
  req: LocalToolRequest,
  cfg: LocalConfig,
): LocalToolResult {
  const decision = evaluateToolRequest(req, cfg);
  if (!decision.allowed || !decision.resolvedPath) {
    return { ok: false, text: `Policy denied: ${decision.reason}`, decision };
  }

  try {
    switch (req.tool) {
      case "fs.read":
        return { ...runRead(decision.resolvedPath), decision };
      case "fs.write":
        return { ...runWrite(decision.resolvedPath, req.args.content), decision };
      case "fs.list":
        return { ...runList(decision.resolvedPath), decision };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, text: `Tool error: ${msg}`, decision };
  }
}

function runRead(filePath: string): { ok: boolean; text: string } {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return { ok: false, text: `Not a file: ${filePath}` };
  }
  if (stat.size > MAX_READ_BYTES) {
    return {
      ok: false,
      text: `File too large (${stat.size} bytes > ${MAX_READ_BYTES}): ${filePath}`,
    };
  }
  return { ok: true, text: fs.readFileSync(filePath, "utf-8") };
}

function runWrite(filePath: string, content: unknown): { ok: boolean; text: string } {
  if (typeof content !== "string") {
    return { ok: false, text: "Write requires a string 'content' argument" };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return { ok: true, text: `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${filePath}` };
}

function runList(dirPath: string): { ok: boolean; text: string } {
  if (!fs.statSync(dirPath).isDirectory()) {
    return { ok: false, text: `Not a directory: ${dirPath}` };
  }
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`);
  return { ok: true, text: entries.length > 0 ? entries.join("\n") : "(empty)" };
}

/** Throw if a required string arg is missing (used before inference calls). */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LocalRuntimeError("INTERNAL", `Missing required string argument: ${name}`);
  }
  return value;
}
