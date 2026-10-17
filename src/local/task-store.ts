/**
 * Local-First Worker — Task Store
 *
 * Persistent task records as one JSON file per task, written atomically
 * (temp file + rename) so a crash never leaves a half-written record.
 * Deliberately plain: no SQLite, no ORM, easy to audit and roll back.
 */

import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { LocalTaskRecord, TaskStatus } from "./types.js";
import { LocalRuntimeError } from "./types.js";

const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class TaskStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  create(prompt: string): LocalTaskRecord {
    const now = new Date().toISOString();
    const record: LocalTaskRecord = {
      id: ulid(),
      prompt,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      steps: [],
    };
    this.save(record);
    return record;
  }

  get(id: string): LocalTaskRecord | undefined {
    if (!VALID_ID.test(id)) {
      throw new LocalRuntimeError("INVALID_TASK", `Invalid task id: ${id}`);
    }
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return undefined;
    try {
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw) as LocalTaskRecord;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LocalRuntimeError("INVALID_TASK", `Corrupt task record ${id}: ${msg}`);
    }
  }

  save(record: LocalTaskRecord): void {
    if (!VALID_ID.test(record.id)) {
      throw new LocalRuntimeError("INVALID_TASK", `Invalid task id: ${record.id}`);
    }
    record.updatedAt = new Date().toISOString();
    const target = this.fileFor(record.id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
    fs.renameSync(tmp, target);
  }

  update(
    id: string,
    mutate: (record: LocalTaskRecord) => void,
  ): LocalTaskRecord {
    const record = this.get(id);
    if (!record) {
      throw new LocalRuntimeError("INVALID_TASK", `Unknown task id: ${id}`);
    }
    mutate(record);
    this.save(record);
    return record;
  }

  setStatus(id: string, status: TaskStatus): LocalTaskRecord {
    return this.update(id, (r) => {
      r.status = status;
    });
  }

  list(): LocalTaskRecord[] {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const records: LocalTaskRecord[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, f), "utf-8");
        records.push(JSON.parse(raw) as LocalTaskRecord);
      } catch {
        // Skip unreadable/corrupt records instead of failing the listing.
      }
    }
    return records;
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}
