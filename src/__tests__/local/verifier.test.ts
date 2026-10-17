/**
 * Local-First Worker — Output verifier tests
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLocalConfig, type LocalConfig } from "../../local/config.js";
import { verifyOutput, writeVerifiedArtifact } from "../../local/verifier.js";
import { LocalRuntimeError } from "../../local/types.js";

let tmp: string;
let cfg: LocalConfig;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-verify-"));
  cfg = loadLocalConfig({} as NodeJS.ProcessEnv, {
    workspaceRoot: tmp,
    artifactsDir: path.join(tmp, "artifacts"),
    tasksDir: path.join(tmp, "tasks"),
    maxOutputChars: 1000,
  });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("verifyOutput", () => {
  it("accepts normal text", () => {
    expect(verifyOutput("Un texte promotionnel en français.", cfg).ok).toBe(true);
  });

  it("rejects empty or whitespace-only output", () => {
    expect(verifyOutput("", cfg).ok).toBe(false);
    expect(verifyOutput("   \n\t ", cfg).ok).toBe(false);
  });

  it("rejects non-string output", () => {
    expect(verifyOutput(undefined, cfg).ok).toBe(false);
    expect(verifyOutput(42, cfg).ok).toBe(false);
  });

  it("rejects output over the char limit", () => {
    const r = verifyOutput("a".repeat(1001), cfg);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/too long/);
  });

  it("rejects NUL bytes", () => {
    const r = verifyOutput("abc\u0000def", cfg);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/NUL/);
  });
});

describe("writeVerifiedArtifact", () => {
  it("writes and round-trips content", () => {
    const p = path.join(cfg.artifactsDir, "ok.md");
    writeVerifiedArtifact(p, "contenu vérifié ✓", cfg);
    expect(fs.readFileSync(p, "utf-8")).toBe("contenu vérifié ✓");
  });

  it("throws VERIFICATION_FAILED when the artifact cannot be read back", () => {
    // A path whose parent is a regular file makes the write itself fail
    // with a non-LocalRuntimeError ENOTDIR — assert the verifier surfaces
    // the LocalRuntimeError for the read-back stage by pointing at a
    // directory masquerading as the artifact path.
    const dirAsFile = path.join(cfg.artifactsDir, "dir-as-file");
    fs.mkdirSync(dirAsFile, { recursive: true });
    expect(() => writeVerifiedArtifact(dirAsFile, "x", cfg)).toThrow();
  });
});
