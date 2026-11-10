import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CadToolError, formatZodIssues } from "../../../packages/shared/errors.js";
import {
  CadJobRequestSchema,
  TERMINAL_STATUSES,
  type ArtifactInfo,
  type CadJobRequest,
  type CadJobResult,
  type JobStatus,
} from "../../../packages/shared/types.js";
import { AuditLog } from "./audit.js";
import { Catalog } from "./catalog.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import { JobStore, type JobRow } from "./job-store.js";
import { runWorkerPhase, tailLog, type PhaseOutcome } from "./worker-launcher.js";

const JOB_ID_RE = /^job_[A-Za-z0-9_-]{22}$/;
const ARTIFACT_ID_RE = /^art_[A-Za-z0-9_-]{16}$/;
const FILE_NAMES: Record<string, string> = { FCStd: "model.FCStd", STEP: "model.step", STL: "model.stl", PNG: "preview.png" };
export const MIME_TYPES: Record<string, string> = {
  FCStd: "application/x-freecad",
  STEP: "model/step",
  STL: "model/stl",
  PNG: "image/png",
};

function newId(prefix: string, bytes: number): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/** Copy only known numeric/string fields out of the (worker-produced) mass report. */
function sanitizeMass(m: unknown): CadJobResult["massProperties"] {
  if (!m || typeof m !== "object") return undefined;
  const o = m as Record<string, unknown>;
  const com = Array.isArray(o.centerOfMassMm) && o.centerOfMassMm.length === 3 ? (o.centerOfMassMm.map((x) => num(x) ?? 0) as [number, number, number]) : [0, 0, 0] as [number, number, number];
  const out: NonNullable<CadJobResult["massProperties"]> = { volumeMm3: num(o.volumeMm3) ?? 0, areaMm2: num(o.areaMm2) ?? 0, centerOfMassMm: com };
  if (typeof o.material === "string") out.material = o.material.slice(0, 32);
  if (num(o.densityGcm3) !== undefined) out.densityGcm3 = num(o.densityGcm3);
  if (num(o.massG) !== undefined) out.massG = num(o.massG);
  return out;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * CAD Capability Gateway: the only component that touches the job store,
 * job directories and FreeCAD worker processes. Every public method takes
 * the calling principal and enforces ownership, validation and limits.
 */
export class CadGateway {
  readonly cfg: GatewayConfig;
  readonly catalog: Catalog;
  private readonly store: JobStore;
  private readonly audit: AuditLog;
  private readonly jobsRoot: string;
  private readonly queue: string[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly submitTimes = new Map<string, number[]>();
  private retentionTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(overrides: Partial<GatewayConfig> = {}) {
    this.cfg = loadConfig(overrides);
    this.jobsRoot = path.join(this.cfg.dataDir, "jobs");
    fs.mkdirSync(this.jobsRoot, { recursive: true, mode: 0o700 });
    this.store = new JobStore(this.cfg.dataDir);
    this.audit = new AuditLog(this.cfg.dataDir);
    this.catalog = new Catalog(this.cfg.catalogPath, this.cfg.examplesDir);
    this.recover();
    this.cleanupExpired();
    this.retentionTimer = setInterval(() => this.cleanupExpired(), 60 * 60 * 1000);
    this.retentionTimer.unref();
  }

  // ------------------------------------------------------------------ public API

  submit(principal: string, input: unknown): { id: string; status: JobStatus; deduplicated?: boolean } {
    const parsed = CadJobRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CadToolError("INVALID_REQUEST", "Invalid CadJobRequest", { issues: formatZodIssues(parsed.error.issues) });
    }
    const request = parsed.data;
    if (request.timeoutSec && request.timeoutSec > this.cfg.maxJobTimeoutSec) {
      throw new CadToolError("INVALID_REQUEST", `timeoutSec must be <= ${this.cfg.maxJobTimeoutSec}`);
    }
    if (request.idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(principal, request.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status, deduplicated: true };
    }
    this.checkRate(principal);
    if (this.store.countActive(principal) >= this.cfg.maxActiveJobsPerPrincipal) {
      throw new CadToolError("QUEUE_FULL", `You already have ${this.cfg.maxActiveJobsPerPrincipal} active jobs.`);
    }
    if (this.queue.length >= this.cfg.maxQueuedJobs) {
      throw new CadToolError("QUEUE_FULL", "The global job queue is full.");
    }

    const id = newId("job", 16);
    const jobDir = this.jobDir(id);
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(jobDir, "script.py"), request.script, { mode: 0o600 });
    fs.writeFileSync(path.join(jobDir, "request.json"), JSON.stringify({ ...request, script: undefined }, null, 1), { mode: 0o600 });
    const scriptSha256 = crypto.createHash("sha256").update(request.script).digest("hex");
    this.store.insert({
      id,
      owner: principal,
      status: "queued",
      idempotencyKey: request.idempotencyKey ?? null,
      request,
      scriptSha256,
      createdAt: Date.now(),
    });
    this.audit.log("job.submitted", { jobId: id, principal, scriptSha256, outputs: request.outputs });
    this.queue.push(id);
    this.pump();
    return { id, status: "queued" };
  }

  status(principal: string, id: string, opts: { includeEvents?: boolean } = {}): CadJobResult & { events?: unknown[]; queuePosition?: number } {
    const job = this.owned(principal, id);
    const out: CadJobResult & { events?: unknown[]; queuePosition?: number } = this.toResult(job);
    if (job.status === "queued") out.queuePosition = this.queue.indexOf(id) + 1;
    if (opts.includeEvents) out.events = this.store.events(id);
    return out;
  }

  /** The stored request of a job the caller owns (used for fromJob variants/repairs). */
  jobRequest(principal: string, id: string): CadJobRequest {
    return this.owned(principal, id).request;
  }

  async wait(principal: string, id: string, timeoutMs: number, signal?: AbortSignal): Promise<CadJobResult> {
    this.owned(principal, id);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const job = this.store.get(id);
      if (!job || TERMINAL_STATUSES.has(job.status) || Date.now() >= deadline || signal?.aborted) {
        return this.status(principal, id);
      }
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set();
        this.waiters.set(id, set);
        const done = () => {
          clearTimeout(t);
          set.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, Math.min(1000, Math.max(0, deadline - Date.now())));
        set.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  cancel(principal: string, id: string): { id: string; status: JobStatus } {
    const job = this.owned(principal, id);
    if (TERMINAL_STATUSES.has(job.status)) return { id, status: job.status };
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.finish(id, "cancelled", { error: { code: "CANCELLED", message: "Cancelled while queued." } });
    } else {
      this.running.get(id)?.abort();
    }
    this.audit.log("job.cancel", { jobId: id, principal });
    return { id, status: this.store.get(id)?.status ?? "cancelled" };
  }

  artifacts(principal: string, id: string): ArtifactInfo[] {
    this.owned(principal, id);
    return this.store.artifacts(id).map(({ jobId: _j, relPath: _p, ...a }) => a);
  }

  /** Resolve an artifact for download. Paths come only from the store, never from the client. */
  artifactFile(principal: string, jobId: string, artifactId: string): { info: ArtifactInfo; file: string; mimeType: string } {
    if (!ARTIFACT_ID_RE.test(artifactId)) throw new CadToolError("NOT_FOUND", "Unknown artifact id.");
    this.owned(principal, jobId);
    const row = this.store.artifacts(jobId).find((a) => a.artifactId === artifactId);
    if (!row) throw new CadToolError("NOT_FOUND", "Unknown artifact id.");
    const jobDir = this.jobDir(jobId);
    const file = path.resolve(jobDir, row.relPath);
    if (!file.startsWith(jobDir + path.sep)) throw new CadToolError("FORBIDDEN", "Artifact path escapes job directory.");
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new CadToolError("NOT_FOUND", "Artifact file no longer exists (retention expired?).");
    const { jobId: _j, relPath: _p, ...info } = row;
    this.audit.log("artifact.access", { jobId, artifactId, principal });
    return { info, file, mimeType: MIME_TYPES[row.format] ?? "application/octet-stream" };
  }

  logs(principal: string, id: string, opts: { phase?: "build" | "verify"; stream?: "stdout" | "stderr"; maxBytes?: number } = {}): string {
    this.owned(principal, id);
    const phase = opts.phase ?? "build";
    const stream = opts.stream ?? "stderr";
    const max = Math.min(Math.max(opts.maxBytes ?? 4000, 100), 32_000);
    return tailLog(path.join(this.jobDir(id), "logs", `${phase}.${stream}.log`), max);
  }

  private versionProbe?: Promise<string | null>;

  /** FreeCAD build reported by the configured runtime (probed once, trusted code only). */
  freecadVersion(): Promise<string | null> {
    this.versionProbe ??= new Promise((resolve) => {
      const code = `import sys; sys.path.append(${JSON.stringify(this.cfg.freecadLib)}); import FreeCAD; v = FreeCAD.Version(); print(".".join(v[:3]) + " " + v[3])`;
      execFile(
        this.cfg.pythonPath,
        ["-I", "-c", code],
        { env: { PATH: "/usr/bin:/bin", HOME: path.join(this.cfg.dataDir, "probe-home"), QT_QPA_PLATFORM: "offscreen" }, timeout: 60_000 },
        (err, stdout) => resolve(err ? null : (stdout.trim().split("\n").at(-1) ?? null)),
      );
    });
    return this.versionProbe;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    for (const c of this.running.values()) c.abort();
    const deadline = Date.now() + 5000;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    this.store.close();
  }

  // ------------------------------------------------------------------ internals

  private jobDir(id: string): string {
    if (!JOB_ID_RE.test(id)) throw new CadToolError("NOT_FOUND", "Unknown job id.");
    return path.join(this.jobsRoot, id);
  }

  private owned(principal: string, id: string): JobRow {
    if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw new CadToolError("NOT_FOUND", "Unknown job id.");
    const job = this.store.get(id);
    // Do not reveal the existence of other principals' jobs.
    if (!job || job.owner !== principal) throw new CadToolError("NOT_FOUND", "Unknown job id.");
    return job;
  }

  private checkRate(principal: string): void {
    const now = Date.now();
    const recent = (this.submitTimes.get(principal) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.cfg.submissionsPerMinute) {
      throw new CadToolError("RATE_LIMITED", `Limit is ${this.cfg.submissionsPerMinute} submissions per minute.`);
    }
    recent.push(now);
    this.submitTimes.set(principal, recent);
  }

  private recover(): void {
    for (const job of this.store.listByStatus("running")) {
      this.store.transition(job.id, "failed", "server restart", {
        result: { error: { code: "WORKER_INTERRUPTED", message: "Server restarted while the job was running." } },
      });
    }
    for (const job of this.store.listByStatus("queued")) this.queue.push(job.id);
    this.pump();
  }

  private cleanupExpired(): void {
    const cutoff = Date.now() - this.cfg.retentionHours * 3600_000;
    for (const id of this.store.listOlderThan(cutoff)) {
      try {
        fs.rmSync(this.jobDir(id), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.store.delete(id);
      this.audit.log("job.expired", { jobId: id });
    }
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.cfg.maxConcurrentJobs && this.queue.length) {
      const id = this.queue.shift()!;
      const ctrl = new AbortController();
      this.running.set(id, ctrl);
      this.execute(id, ctrl.signal)
        .catch((err: unknown) => {
          this.finish(id, "failed", { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } });
        })
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
  }

  private finish(id: string, status: JobStatus, result: Partial<CadJobResult>): void {
    const prev = this.store.get(id)?.result ?? {};
    this.store.transition(id, status, result.error?.code, { result: { ...prev, ...result } });
    this.audit.log("job.finished", { jobId: id, status, error: result.error?.code, durationMs: result.durationMs });
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
  }

  private phaseFailure(o: PhaseOutcome, phase: string, timeoutSec: number): { status: JobStatus; error: CadJobResult["error"] } | null {
    if (o.cancelled) return { status: "cancelled", error: { code: "CANCELLED", message: `Cancelled during ${phase}.` } };
    if (o.timedOut) return { status: "failed", error: { code: "TIMEOUT", message: `${phase} exceeded ${timeoutSec}s wall time.` } };
    if (!o.report) {
      const how = o.signal ? `signal ${o.signal}` : `exit code ${o.exitCode}`;
      return {
        status: "failed",
        error: {
          code: o.signal === "SIGXCPU" ? "TIMEOUT" : "WORKER_CRASHED",
          message: `FreeCAD ${phase} process ended (${how}) without a report.`,
        },
      };
    }
    return null;
  }

  private async execute(id: string, signal: AbortSignal): Promise<void> {
    const job = this.store.get(id);
    if (!job || job.status !== "queued") return;
    const req: CadJobRequest = job.request;
    const timeoutSec = Math.min(req.timeoutSec ?? this.cfg.defaultJobTimeoutSec, this.cfg.maxJobTimeoutSec);
    const jobDir = this.jobDir(id);
    const workDir = path.join(jobDir, "work");
    const t0 = Date.now();
    this.store.transition(id, "running", "build");
    this.audit.log("job.started", { jobId: id });

    const limits = { cpuSeconds: timeoutSec, addressSpaceMb: this.cfg.addressSpaceMb, fileSizeMb: this.cfg.fileSizeMb };
    const requestForWorker = { outputs: req.outputs, validation: req.validation, parameters: req.parameters ?? {} };

    // ---- build (untrusted code) -------------------------------------------
    const build = await runWorkerPhase(this.cfg, "build", jobDir, { script: req.script, request: requestForWorker, limits }, timeoutSec * 1000, signal);
    const bFail = this.phaseFailure(build, "build", timeoutSec);
    if (bFail) return this.finishAndClean(id, bFail.status, { error: bFail.error, durationMs: Date.now() - t0 });

    const b = build.report!;
    const freecadVersion = typeof b.freecadVersion === "string" ? b.freecadVersion.slice(0, 80) : undefined;
    if (!b.ok) {
      const e = (b.error ?? {}) as Record<string, unknown>;
      const code = typeof e.code === "string" && /^[A-Z_]{3,40}$/.test(e.code) ? e.code : "SCRIPT_ERROR";
      return this.finishAndClean(id, "failed", {
        freecadVersion,
        durationMs: Date.now() - t0,
        featureErrors: Array.isArray(e.featureErrors) ? e.featureErrors.slice(0, 20) : undefined,
        error: {
          code,
          message: String(e.message ?? "Build failed").slice(0, 2000),
          traceback: typeof e.traceback === "string" ? e.traceback.slice(-4000) : undefined,
        },
      });
    }
    const resultObject = typeof b.resultObject === "string" && /^[A-Za-z0-9_]{1,128}$/.test(b.resultObject) ? b.resultObject : undefined;

    // ---- verify (trusted code, fresh process, untrusted files) ---------------
    this.store.transition(id, "running", "verify");
    const verify = await runWorkerPhase(
      this.cfg,
      "verify",
      jobDir,
      { request: requestForWorker, limits, resultObject },
      timeoutSec * 1000,
      signal,
    );
    const vFail = this.phaseFailure(verify, "verify", timeoutSec);
    if (vFail) return this.finishAndClean(id, vFail.status, { freecadVersion, error: vFail.error, durationMs: Date.now() - t0 });
    const v = verify.report!;
    const fcEntry = Array.isArray(v.artifactChecks)
      ? (v.artifactChecks as Record<string, unknown>[]).find((a) => a.format === "FCStd")
      : undefined;
    const tree = fcEntry?.featureTree as Record<string, unknown> | undefined;
    const pngEntry = Array.isArray(v.artifactChecks)
      ? (v.artifactChecks as Record<string, unknown>[]).find((a) => a.format === "PNG")
      : undefined;
    const base: Partial<CadJobResult> = {
      freecadVersion: typeof v.freecadVersion === "string" ? v.freecadVersion : freecadVersion,
      geometry: v.geometry as CadJobResult["geometry"],
      checks: Array.isArray(v.checks) ? (v.checks as CadJobResult["checks"]) : undefined,
      detectedHoles: Array.isArray(v.detectedHoles) ? v.detectedHoles.slice(0, 50) : undefined,
      featureErrors: Array.isArray(b.featureErrors) && b.featureErrors.length ? b.featureErrors.slice(0, 20) : undefined,
      featureTree: tree
        ? {
            sketchConstraints: Number(tree.sketchConstraints ?? 0),
            expressions: Number(tree.expressions ?? 0),
            types: Object.keys((tree.typeCounts as object) ?? {}).slice(0, 40),
            sketches: Array.isArray(tree.sketches)
              ? (tree.sketches as Record<string, unknown>[]).slice(0, 50).map((k) => ({
                  name: String(k.name ?? "").slice(0, 128),
                  dof: typeof k.dof === "number" ? k.dof : null,
                  fullyConstrained: typeof k.fullyConstrained === "boolean" ? k.fullyConstrained : null,
                }))
              : undefined,
          }
        : undefined,
      massProperties: sanitizeMass(v.massProperties),
      preview: pngEntry ? { rendered: Boolean(pngEntry.rendered), nonBlankFraction: num(pngEntry.nonBlankFraction) } : undefined,
      sandbox: v.sandbox as CadJobResult["sandbox"],
    };
    if (!v.ok) {
      const e = (v.error ?? {}) as Record<string, unknown>;
      return this.finishAndClean(id, "failed", {
        ...base,
        durationMs: Date.now() - t0,
        error: { code: "VALIDATION_FAILED", message: String(e.message ?? "Validation failed").slice(0, 2000) },
      });
    }

    // ---- publish artifacts (copy out of the sandbox root, hash) -------------
    const artDir = path.join(jobDir, "artifacts");
    fs.mkdirSync(artDir, { recursive: true, mode: 0o700 });
    const published: ArtifactInfo[] = [];
    for (const fmt of req.outputs) {
      const name = FILE_NAMES[fmt];
      const src = path.join(workDir, "out", name);
      const st = fs.lstatSync(src, { throwIfNoEntry: false });
      if (!st || !st.isFile() || st.size === 0) {
        return this.finishAndClean(id, "failed", {
          ...base,
          durationMs: Date.now() - t0,
          error: { code: "EXPORT_FAILED", message: `${fmt} artifact missing or empty.` },
        });
      }
      const dst = path.join(artDir, name);
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      const artifactId = newId("art", 12);
      const info: ArtifactInfo = {
        artifactId,
        name,
        format: fmt,
        sizeBytes: fs.statSync(dst).size,
        sha256: sha256File(dst),
        resourceUri: `freecad-artifact://${id}/${artifactId}`,
      };
      this.store.addArtifact({ ...info, jobId: id, relPath: path.join("artifacts", name) });
      published.push(info);
    }
    this.finishAndClean(id, "completed", { ...base, artifacts: published, durationMs: Date.now() - t0 });
  }

  private finishAndClean(id: string, status: JobStatus, result: Partial<CadJobResult>): void {
    this.finish(id, status, result);
    if (!this.cfg.keepWorkDirs) {
      try {
        fs.rmSync(path.join(this.jobDir(id), "work"), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private toResult(job: JobRow): CadJobResult {
    const r = job.result ?? {};
    const out: CadJobResult = {
      ...r,
      id: job.id,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
    };
    if (job.startedAt) out.startedAt = new Date(job.startedAt).toISOString();
    if (job.finishedAt) out.finishedAt = new Date(job.finishedAt).toISOString();
    if (out.error && !out.error.hint) {
      const hint = new CadToolError(out.error.code, "").hint;
      if (hint) out.error = { ...out.error, hint };
    }
    return out;
  }
}
