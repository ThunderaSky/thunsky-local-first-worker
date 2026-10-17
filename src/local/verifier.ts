/**
 * Local-First Worker — Output Verification
 *
 * Verifies model output before it is persisted as an artifact, and
 * verifies the artifact round-trip (bytes on disk == bytes verified).
 * Failures here mark the task failed with VERIFICATION_FAILED — we never
 * save an artifact we could not verify.
 */

import fs from "node:fs";
import type { LocalConfig } from "./config.js";
import { LocalRuntimeError } from "./types.js";

export interface VerificationResult {
  ok: boolean;
  problems: string[];
}

/** Static checks on the model output text. */
export function verifyOutput(content: unknown, cfg: LocalConfig): VerificationResult {
  const problems: string[] = [];
  if (typeof content !== "string") {
    return { ok: false, problems: ["Output is not a string"] };
  }
  if (content.trim().length === 0) {
    problems.push("Output is empty or whitespace only");
  }
  if (content.length > cfg.maxOutputChars) {
    problems.push(
      `Output too long: ${content.length} chars > limit ${cfg.maxOutputChars}`,
    );
  }
  if (content.includes("\u0000")) {
    problems.push("Output contains NUL bytes");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Write the artifact and verify the round-trip: read it back and require
 * byte-for-byte equality with the verified content.
 */
export function writeVerifiedArtifact(
  artifactPath: string,
  content: string,
  cfg: LocalConfig,
): void {
  fs.mkdirSync(cfg.artifactsDir, { recursive: true });
  fs.writeFileSync(artifactPath, content, "utf-8");

  let readBack: string;
  try {
    readBack = fs.readFileSync(artifactPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LocalRuntimeError(
      "VERIFICATION_FAILED",
      `Artifact unreadable after write: ${msg}`,
    );
  }
  if (readBack !== content) {
    throw new LocalRuntimeError(
      "VERIFICATION_FAILED",
      `Artifact round-trip mismatch: ${artifactPath}`,
    );
  }
}
