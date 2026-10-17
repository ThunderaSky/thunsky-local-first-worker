/**
 * Local-First Worker — Task store tests
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskStore } from "../../local/task-store.js";
import { LocalRuntimeError } from "../../local/types.js";

let tmp: string;
let store: TaskStore;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-store-"));
  store = new TaskStore(path.join(tmp, "tasks"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("TaskStore", () => {
  it("creates a pending record with an id", () => {
    const r = store.create("test prompt");
    expect(r.id).toMatch(/^[A-Z0-9]+$/);
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(0);
    expect(store.get(r.id)?.prompt).toBe("test prompt");
  });

  it("persists updates across instances", () => {
    const r = store.create("persist me");
    store.update(r.id, (rec) => {
      rec.status = "succeeded";
      rec.artifactPath = "/tmp/x.md";
    });
    const fresh = new TaskStore(path.join(tmp, "tasks"));
    const loaded = fresh.get(r.id);
    expect(loaded?.status).toBe("succeeded");
    expect(loaded?.artifactPath).toBe("/tmp/x.md");
  });

  it("lists all records", () => {
    const before = store.list().length;
    store.create("a");
    store.create("b");
    expect(store.list().length).toBe(before + 2);
  });

  it("rejects invalid ids (traversal)", () => {
    expect(() => store.get("../evil")).toThrow(LocalRuntimeError);
    expect(() =>
      store.save({ id: "../evil", prompt: "x", status: "pending", createdAt: "", updatedAt: "", attempts: 0, steps: [] }),
    ).toThrow(LocalRuntimeError);
  });

  it("throws INVALID_TASK for unknown ids", () => {
    expect(() => store.update("NOPE", () => {})).toThrow(/Unknown task/);
  });

  it("returns undefined for a missing record", () => {
    expect(store.get("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeUndefined();
  });
});
