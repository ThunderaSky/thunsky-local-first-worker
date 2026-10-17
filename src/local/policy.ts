/**
 * Local-First Worker — Policy Gateway
 *
 * Every tool execution in the local runtime passes through this gateway.
 * The model never calls tools directly; the runner submits each intended
 * call here first and executes only on an explicit allow decision.
 *
 * Rules (deny by default):
 *   - Only the local tool allowlist is executable.
 *   - Reads must resolve inside workspaceRoot (symlinks resolved first).
 *   - Sensitive files (.env*, keys, wallet state) are always denied.
 *   - Writes are restricted to the artifacts directory.
 *   - No shell execution, no network tools, no financial operations.
 */

import fs from "node:fs";
import path from "node:path";
import type { LocalConfig } from "./config.js";
import { isInside } from "./config.js";

export type LocalToolName = "fs.read" | "fs.write" | "fs.list";

export const ALLOWED_TOOLS: readonly LocalToolName[] = ["fs.read", "fs.write", "fs.list"];

export interface LocalToolRequest {
  tool: LocalToolName;
  args: Record<string, unknown>;
}

export interface LocalPolicyDecision {
  allowed: boolean;
  reason: string;
  /** Absolute, sandbox-resolved path when the request targets a file. */
  resolvedPath?: string;
}

/** File name fragments that are never readable or writable, anywhere. */
const SENSITIVE_PATTERNS = [
  /(^|[/\\])\.env(\..+)?$/i,
  /(^|[/\\])\.ssh([/\\]|$)/i,
  /(^|[/\\])\.gnupg([/\\]|$)/i,
  /(^|[/\\])\.aws([/\\]|$)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])id_(rsa|ed25519|ecdsa)[^/\\]*$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|[/\\])wallet\.json$/i,
  /(^|[/\\])genesis\.json$/i,
  /(^|[/\\])\.automaton[/\\]/i,
];

export function evaluateToolRequest(
  req: LocalToolRequest,
  cfg: LocalConfig,
): LocalPolicyDecision {
  if (!ALLOWED_TOOLS.includes(req.tool)) {
    return { allowed: false, reason: `Tool not in local allowlist: ${req.tool}` };
  }

  const rawPath = req.args.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { allowed: false, reason: "Missing or invalid 'path' argument" };
  }

  if (req.tool === "fs.write") {
    const resolved = path.resolve(cfg.artifactsDir, rawPath);
    if (!isInside(resolved, cfg.artifactsDir)) {
      return {
        allowed: false,
        reason: `Write escapes artifacts directory: ${rawPath}`,
      };
    }
    if (isSensitive(resolved)) {
      return { allowed: false, reason: `Sensitive file: ${rawPath}` };
    }
    return { allowed: true, reason: "Write inside artifacts directory", resolvedPath: resolved };
  }

  // fs.read and fs.list: must stay inside the workspace sandbox.
  const resolved = path.resolve(cfg.workspaceRoot, rawPath);
  if (!isInside(resolved, cfg.workspaceRoot)) {
    return {
      allowed: false,
      reason: `Path escapes workspace sandbox: ${rawPath}`,
    };
  }
  if (isSensitive(resolved)) {
    return { allowed: false, reason: `Sensitive file: ${rawPath}` };
  }

  // Defeat symlinks: resolve the real path of the deepest existing ancestor
  // and require it to stay inside the sandbox too.
  const real = realpathDeepest(resolved);
  if (!isInside(real, cfg.workspaceRoot)) {
    return {
      allowed: false,
      reason: `Symlink resolves outside workspace sandbox: ${rawPath}`,
    };
  }

  return { allowed: true, reason: "Path inside workspace sandbox", resolvedPath: resolved };
}

function isSensitive(p: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(p));
}

/** realpath the deepest existing ancestor of `target`, re-append the rest. */
function realpathDeepest(target: string): string {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return rest.length > 0 ? path.join(real, ...rest) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target; // nothing exists; use as-is
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
