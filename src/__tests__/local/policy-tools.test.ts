/**
 * Local-First Worker — Policy gateway tests
 * Path sandbox, sensitive-file denial, write restrictions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLocalConfig, type LocalConfig } from "../../local/config.js";
import { evaluateToolRequest } from "../../local/policy.js";
import { authorizeAndRun } from "../../local/tools.js";

let tmp: string;
let cfg: LocalConfig;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-policy-"));
  cfg = loadLocalConfig({} as NodeJS.ProcessEnv, {
    workspaceRoot: tmp,
    artifactsDir: path.join(tmp, "artifacts"),
    tasksDir: path.join(tmp, "tasks"),
  });
  fs.writeFileSync(path.join(tmp, "hello.txt"), "hello world", "utf-8");
  fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("evaluateToolRequest", () => {
  it("allows reading a file inside the sandbox", () => {
    const d = evaluateToolRequest(
      { tool: "fs.read", args: { path: "hello.txt" } },
      cfg,
    );
    expect(d.allowed).toBe(true);
    expect(d.resolvedPath).toBe(path.join(tmp, "hello.txt"));
  });

  it("denies traversal outside the sandbox", () => {
    const d = evaluateToolRequest(
      { tool: "fs.read", args: { path: "../outside.txt" } },
      cfg,
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/escapes/);
  });

  it("denies absolute paths outside the sandbox", () => {
    const d = evaluateToolRequest(
      { tool: "fs.read", args: { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" } },
      cfg,
    );
    expect(d.allowed).toBe(false);
  });

  it("denies sensitive files (.env)", () => {
    const d = evaluateToolRequest(
      { tool: "fs.read", args: { path: ".env" } },
      cfg,
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Sensitive/);
  });

  it("denies key files anywhere in the tree", () => {
    const d = evaluateToolRequest(
      { tool: "fs.read", args: { path: "sub/id_rsa_backup" } },
      cfg,
    );
    expect(d.allowed).toBe(false);
  });

  it("denies unknown tools", () => {
    const d = evaluateToolRequest(
      { tool: "shell.exec" as any, args: { command: "rm -rf /" } },
      cfg,
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/allowlist/);
  });

  it("denies writes outside the artifacts directory", () => {
    const d = evaluateToolRequest(
      { tool: "fs.write", args: { path: "../escape.md", content: "x" } },
      cfg,
    );
    expect(d.allowed).toBe(false);
  });

  it("allows writes inside the artifacts directory", () => {
    const d = evaluateToolRequest(
      { tool: "fs.write", args: { path: "out.md", content: "x" } },
      cfg,
    );
    expect(d.allowed).toBe(true);
  });

  it("denies symlink escapes (when symlink creation is permitted)", () => {
    const target = path.join(tmp, "sub", "link-out");
    const outside = path.join(os.tmpdir(), "outside-sandbox-target.txt");
    try {
      fs.symlinkSync(outside, target, "file");
    } catch {
      return; // Windows without developer mode/admin: skip
    }
    const d = evaluateToolRequest(
      { tool: "fs.read", args: { path: "sub/link-out" } },
      cfg,
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Symlink/);
  });
});

describe("authorizeAndRun", () => {
  it("reads an allowed file", () => {
    const r = authorizeAndRun({ tool: "fs.read", args: { path: "hello.txt" } }, cfg);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("hello world");
  });

  it("returns (not throws) on policy denial", () => {
    const r = authorizeAndRun(
      { tool: "fs.read", args: { path: "../../etc/passwd" } },
      cfg,
    );
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Policy denied/);
  });

  it("writes inside artifacts and lists the directory", () => {
    const w = authorizeAndRun(
      { tool: "fs.write", args: { path: "nested/x.md", content: "content" } },
      cfg,
    );
    expect(w.ok).toBe(true);
    const l = authorizeAndRun(
      { tool: "fs.list", args: { path: "artifacts/nested" } },
      cfg,
    );
    expect(l.ok).toBe(true);
    expect(l.text).toContain("x.md");
  });

  it("refuses oversized reads", () => {
    const big = path.join(tmp, "big.txt");
    fs.writeFileSync(big, "a".repeat(300 * 1024), "utf-8");
    const r = authorizeAndRun({ tool: "fs.read", args: { path: "big.txt" } }, cfg);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/too large/);
  });
});
