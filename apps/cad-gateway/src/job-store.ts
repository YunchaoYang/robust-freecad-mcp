import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { ArtifactInfo, CadJobRequest, CadJobResult, JobStatus } from "../../../packages/shared/types.js";

export interface JobRow {
  id: string;
  owner: string;
  status: JobStatus;
  idempotencyKey: string | null;
  request: CadJobRequest;
  scriptSha256: string;
  result: Partial<CadJobResult> | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ArtifactRow extends ArtifactInfo {
  jobId: string;
  /** Path relative to the job directory. Server-controlled; never client-supplied. */
  relPath: string;
}

/** SQLite-backed job metadata, state transitions and artifact registry. */
export class JobStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "jobs.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT,
        request_json TEXT NOT NULL,
        script_sha256 TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_idem ON jobs(owner, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_owner_status ON jobs(owner, status);
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        rel_path TEXT NOT NULL
      );
    `);
  }

  insert(job: Omit<JobRow, "result" | "startedAt" | "finishedAt">): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, owner, status, idempotency_key, request_json, script_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(job.id, job.owner, job.status, job.idempotencyKey, JSON.stringify(job.request), job.scriptSha256, job.createdAt);
    this.event(job.id, job.status, "submitted");
  }

  get(id: string): JobRow | undefined {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.toRow(r) : undefined;
  }

  findByIdempotencyKey(owner: string, key: string): JobRow | undefined {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE owner = ? AND idempotency_key = ?`).get(owner, key) as
      | Record<string, unknown>
      | undefined;
    return r ? this.toRow(r) : undefined;
  }

  countActive(owner?: string): number {
    const sql = `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')` + (owner ? ` AND owner = ?` : "");
    const r = (owner ? this.db.prepare(sql).get(owner) : this.db.prepare(sql).get()) as { n: number };
    return Number(r.n);
  }

  listByStatus(status: JobStatus): JobRow[] {
    return (this.db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at`).all(status) as Record<string, unknown>[]).map(
      (r) => this.toRow(r),
    );
  }

  listOlderThan(cutoffMs: number): string[] {
    return (
      this.db
        .prepare(`SELECT id FROM jobs WHERE created_at < ? AND status IN ('completed','failed','cancelled')`)
        .all(cutoffMs) as { id: string }[]
    ).map((r) => r.id);
  }

  transition(id: string, status: JobStatus, detail?: string, patch: { result?: Partial<CadJobResult> } = {}): void {
    const now = Date.now();
    const sets = ["status = ?"];
    const args: (string | number | null)[] = [status];
    if (status === "running") {
      sets.push("started_at = ?");
      args.push(now);
    }
    if (status === "completed" || status === "failed" || status === "cancelled") {
      sets.push("finished_at = ?");
      args.push(now);
    }
    if (patch.result !== undefined) {
      sets.push("result_json = ?");
      args.push(JSON.stringify(patch.result));
    }
    args.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    this.event(id, status, detail);
  }

  events(id: string): { ts: string; status: string; detail: string | null }[] {
    return (this.db.prepare(`SELECT ts, status, detail FROM job_events WHERE job_id = ? ORDER BY id`).all(id) as {
      ts: number;
      status: string;
      detail: string | null;
    }[]).map((e) => ({ ts: new Date(e.ts).toISOString(), status: e.status, detail: e.detail }));
  }

  addArtifact(a: ArtifactRow): void {
    this.db
      .prepare(`INSERT INTO artifacts (id, job_id, name, format, size_bytes, sha256, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(a.artifactId, a.jobId, a.name, a.format, a.sizeBytes, a.sha256, a.relPath);
  }

  artifacts(jobId: string): ArtifactRow[] {
    return (this.db.prepare(`SELECT * FROM artifacts WHERE job_id = ? ORDER BY name`).all(jobId) as Record<string, unknown>[]).map((r) => ({
      artifactId: String(r.id),
      jobId: String(r.job_id),
      name: String(r.name),
      format: r.format as ArtifactRow["format"],
      sizeBytes: Number(r.size_bytes),
      sha256: String(r.sha256),
      relPath: String(r.rel_path),
      resourceUri: `freecad-artifact://${String(r.job_id)}/${String(r.id)}`,
    }));
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }

  private event(id: string, status: string, detail?: string): void {
    this.db.prepare(`INSERT INTO job_events (job_id, ts, status, detail) VALUES (?, ?, ?, ?)`).run(id, Date.now(), status, detail ?? null);
  }

  private toRow(r: Record<string, unknown>): JobRow {
    return {
      id: String(r.id),
      owner: String(r.owner),
      status: r.status as JobStatus,
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      request: JSON.parse(String(r.request_json)) as CadJobRequest,
      scriptSha256: String(r.script_sha256),
      result: r.result_json ? (JSON.parse(String(r.result_json)) as Partial<CadJobResult>) : null,
      createdAt: Number(r.created_at),
      startedAt: r.started_at == null ? null : Number(r.started_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    };
  }
}
