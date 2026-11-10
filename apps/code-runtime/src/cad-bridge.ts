import { CadToolError } from "../../../packages/shared/errors.js";
import type { CadJobResult } from "../../../packages/shared/types.js";
import type { CadGateway } from "../../cad-gateway/src/gateway.js";
import { searchCatalog, getCatalogEntry } from "./catalog-view.js";
import type { ExecutionLimits } from "./limits.js";

/**
 * Host side of the `cad` bridge: the ONLY capabilities a Code Mode program has.
 * Each method takes a JSON-decoded argument, validates it, and calls the gateway
 * as the session principal. Nothing here exposes paths, processes or the network.
 *
 * Token economy: scripts never need to round-trip through the model. A job can be
 * built from a catalog example ({exampleId, parameters}) or derived from an earlier
 * job ({fromJob, patch, parameters, validation}), and results default to a compact
 * summary in which passing checks are only counted.
 */
export const BRIDGE_API_VERSION = "1.2";
export const PREVIEW_MARKER = "$cadPreview";
export const SERVER_ID = "robust-freecad-mcp";

export type BridgeMethod = (arg: unknown, ctx: BridgeContext) => Promise<unknown>;

export interface BridgeContext {
  principal: string;
  remainingMs: () => number;
  signal: AbortSignal;
  limits: ExecutionLimits;
  counters: { submits: number };
  submittedJobs: string[];
}

function obj(arg: unknown, method: string): Record<string, unknown> {
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
    throw new CadToolError("INVALID_REQUEST", `cad.${method} expects an object argument`);
  }
  return arg as Record<string, unknown>;
}

function str(v: unknown, name: string, max = 256): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new CadToolError("INVALID_REQUEST", `${name} must be a non-empty string`);
  return v;
}

function plainObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Apply exact-match text patches; each `find` must occur exactly once. */
export function applyPatches(script: string, patches: unknown): string {
  if (patches === undefined) return script;
  if (!Array.isArray(patches) || patches.length > 50) throw new CadToolError("INVALID_REQUEST", "patch must be an array of at most 50 {find, replace}");
  let out = script;
  patches.forEach((p, i) => {
    const o = plainObj(p);
    if (!o || typeof o.find !== "string" || o.find.length === 0 || typeof o.replace !== "string") {
      throw new CadToolError("INVALID_REQUEST", `patch[${i}] must be {find: non-empty string, replace: string}`);
    }
    const first = out.indexOf(o.find);
    if (first < 0) throw new CadToolError("INVALID_REQUEST", `patch[${i}].find not found in the script`, { find: o.find.slice(0, 200) });
    if (out.indexOf(o.find, first + 1) >= 0) {
      throw new CadToolError("INVALID_REQUEST", `patch[${i}].find occurs more than once; include more surrounding text`, { find: o.find.slice(0, 200) });
    }
    out = out.slice(0, first) + o.replace + out.slice(first + o.find.length);
  });
  return out;
}

/**
 * Expand bridge conveniences into a full CadJobRequest:
 *   {exampleId, parameters?, outputs?, validation?}  - start from a catalog example
 *   {fromJob, patch?, parameters?, outputs?, validation?} - variant/repair of an earlier job
 *   plain CadJobRequest (scriptLanguage defaults to 'freecad-python')
 */
export function resolveRequest(gw: CadGateway, principal: string, raw: Record<string, unknown>): Record<string, unknown> {
  const { exampleId, fromJob, patch, ...rest } = raw;
  if (exampleId !== undefined && fromJob !== undefined) throw new CadToolError("INVALID_REQUEST", "Use either exampleId or fromJob, not both.");
  const params = plainObj(rest.parameters);
  const validation = plainObj(rest.validation);

  if (exampleId !== undefined) {
    const entry = gw.catalog.get(str(exampleId, "exampleId"));
    const source = entry ? gw.catalog.exampleSource(entry) : undefined;
    if (!entry || !source) throw new CadToolError("NOT_FOUND", `No runnable example '${String(exampleId)}'. Search with {kind:'example'}.`);
    const defaults = plainObj(entry.parameters) ?? {};
    const overridden = params ? Object.keys(params).some((k) => params[k] !== defaults[k]) : false;
    // The example's full validation spec is only correct for its default parameters; with
    // overrides keep just the dimension-independent requirements so the default path stays validated.
    const ex = plainObj(entry.validationExample);
    const DIMENSIONLESS = ["requireValidShape", "requireSolid", "requireParametric", "requireFullyConstrained", "expectedSolidCount", "expectedHoleCount", "material"];
    const exampleValidation = ex
      ? overridden
        ? Object.fromEntries(Object.entries(ex).filter(([k]) => DIMENSIONLESS.includes(k)))
        : ex
      : undefined;
    return {
      outputs: ["FCStd", "STEP"],
      ...rest,
      script: applyPatches(source, patch),
      scriptLanguage: "freecad-python",
      // Only caller overrides: the example script carries its own defaults, so patches to
      // those defaults still take effect (merged defaults would silently override them).
      parameters: { ...(params ?? {}) },
      validation: validation ?? exampleValidation ?? { requireValidShape: true, requireSolid: true },
    };
  }
  if (fromJob !== undefined) {
    const prev = gw.jobRequest(principal, str(fromJob, "fromJob"));
    const { idempotencyKey: _k, ...prevRest } = prev;
    return {
      ...prevRest,
      ...rest,
      script: applyPatches(typeof rest.script === "string" ? rest.script : prev.script, patch),
      parameters: { ...(prev.parameters ?? {}), ...(params ?? {}) },
      // Shallow merge so a repair only sends the fields it changes.
      validation: { ...(prev.validation ?? {}), ...(validation ?? {}) },
    };
  }
  if (patch !== undefined) throw new CadToolError("INVALID_REQUEST", "patch requires fromJob or exampleId.");
  return { scriptLanguage: "freecad-python", ...rest };
}

export interface CompactResult {
  id: string;
  status: string;
  ok: boolean;
  checks?: { passed: number; total: number };
  failed?: { name: string; expected?: unknown; actual?: unknown; message?: string }[];
  geometry?: { bbox: unknown; volume: unknown; solids: unknown; valid: unknown };
  massG?: number;
  artifacts?: { id: string; format: string; bytes: number }[];
  preview?: boolean;
  error?: { code: string; message: string; hint?: string; traceback?: string };
  featureErrors?: unknown[];
}

/** Token-lean view of a job result: failing checks in full, passing ones only counted. */
export function compact(r: CadJobResult): CompactResult {
  const checks = r.checks ?? [];
  const failed = checks.filter((c) => !c.passed);
  const out: CompactResult = { id: r.id, status: r.status, ok: r.status === "completed" };
  if (checks.length) out.checks = { passed: checks.length - failed.length, total: checks.length };
  if (failed.length) out.failed = failed.slice(0, 20).map((c) => ({ name: c.name, expected: c.expected, actual: c.actual, message: c.message || undefined }));
  if (r.geometry) out.geometry = { bbox: r.geometry.boundingBoxMm, volume: r.geometry.volumeMm3, solids: r.geometry.solidCount, valid: r.geometry.valid };
  if (typeof r.massProperties?.massG === "number") out.massG = Math.round(r.massProperties.massG * 100) / 100;
  if (r.artifacts?.length) out.artifacts = r.artifacts.map((a) => ({ id: a.artifactId, format: a.format, bytes: a.sizeBytes }));
  if (r.artifacts?.some((a) => a.format === "PNG")) out.preview = true;
  if (r.error) out.error = { code: r.error.code, message: r.error.message, hint: r.error.hint, traceback: r.error.traceback };
  if (r.featureErrors?.length) out.featureErrors = r.featureErrors.slice(0, 5);
  return out;
}

function holeCount(r: CadJobResult): number | undefined {
  return Array.isArray(r.detectedHoles) ? r.detectedHoles.length : undefined;
}

export function createBridge(gw: CadGateway): Record<string, BridgeMethod> {
  const submit = (raw: unknown, ctx: BridgeContext) => {
    if (ctx.counters.submits >= ctx.limits.maxSubmits) {
      throw new CadToolError("BUDGET_EXCEEDED", `At most ${ctx.limits.maxSubmits} job submissions per execute.`);
    }
    const request = resolveRequest(gw, ctx.principal, obj(raw, "submit"));
    ctx.counters.submits++;
    const r = gw.submit(ctx.principal, request);
    ctx.submittedJobs.push(r.id);
    return r;
  };
  const waitFor = (id: string, timeoutMs: unknown, ctx: BridgeContext) => {
    const requested = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 300_000;
    const budget = Math.max(0, ctx.remainingMs() - 500); // headroom to process the result
    return gw.wait(ctx.principal, id, Math.min(requested, budget), ctx.signal);
  };

  return {
    async submit(arg, ctx) {
      return submit(arg, ctx);
    },
    async run(arg, ctx) {
      const a = obj(arg, "run");
      const opts = plainObj(a.options) ?? {};
      const { options: _o, ...request } = a;
      const job = submit(request, ctx);
      const r = await waitFor(job.id, opts.timeoutMs, ctx);
      return opts.full === true ? r : compact(r);
    },
    async result(arg, ctx) {
      const a = obj(arg, "result");
      const r = gw.status(ctx.principal, str(a.id, "id"));
      return a.full === true ? r : compact(r);
    },
    async status(arg, ctx) {
      const a = obj(arg, "status");
      return gw.status(ctx.principal, str(a.id, "id"), { includeEvents: a.includeEvents === true });
    },
    async wait(arg, ctx) {
      const a = obj(arg, "wait");
      const r = await waitFor(str(a.id, "id"), a.timeoutMs, ctx);
      return a.compact === true ? compact(r) : r;
    },
    async compare(arg, ctx) {
      const a = obj(arg, "compare");
      const A = gw.status(ctx.principal, str(a.a, "a"));
      const B = gw.status(ctx.principal, str(a.b, "b"));
      const num = (x: unknown) => (typeof x === "number" ? x : undefined);
      const diff = (x?: number, y?: number) => (x !== undefined && y !== undefined ? Math.round((y - x) * 1000) / 1000 : undefined);
      const bbA = A.geometry?.boundingBoxMm;
      const bbB = B.geometry?.boundingBoxMm;
      const failedNames = (r: CadJobResult) => (r.checks ?? []).filter((c) => !c.passed).map((c) => c.name);
      const fa = new Set(failedNames(A));
      const fb = new Set(failedNames(B));
      return {
        a: A.id,
        b: B.id,
        status: [A.status, B.status],
        bboxMm: { a: bbA, b: bbB, delta: bbA && bbB ? bbA.map((v, i) => Math.round((bbB[i] - v) * 1000) / 1000) : undefined },
        volumeMm3: { a: num(A.geometry?.volumeMm3), b: num(B.geometry?.volumeMm3), delta: diff(num(A.geometry?.volumeMm3), num(B.geometry?.volumeMm3)) },
        massG: { a: A.massProperties?.massG, b: B.massProperties?.massG, delta: diff(A.massProperties?.massG, B.massProperties?.massG) },
        holes: { a: holeCount(A), b: holeCount(B) },
        solids: { a: A.geometry?.solidCount, b: B.geometry?.solidCount },
        checksNewlyFailing: [...fb].filter((n) => !fa.has(n)),
        checksFixed: [...fa].filter((n) => !fb.has(n)),
      };
    },
    async cancel(arg, ctx) {
      return gw.cancel(ctx.principal, str(obj(arg, "cancel").id, "id"));
    },
    async artifacts(arg, ctx) {
      return gw.artifacts(ctx.principal, str(obj(arg, "artifacts").id, "id"));
    },
    async logs(arg, ctx) {
      const a = obj(arg, "logs");
      const phase = a.phase === "verify" ? "verify" : "build";
      const stream = a.stream === "stdout" ? "stdout" : "stderr";
      const maxBytes = typeof a.maxBytes === "number" ? a.maxBytes : 4000;
      return gw.logs(ctx.principal, str(a.id, "id"), { phase, stream, maxBytes });
    },
    async search(arg) {
      const a = obj(arg, "search");
      return searchCatalog(gw.catalog, {
        query: typeof a.query === "string" ? a.query.slice(0, 500) : "",
        module: typeof a.module === "string" ? a.module : undefined,
        kind: typeof a.kind === "string" ? a.kind : undefined,
        tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string").slice(0, 10) : undefined,
        limit: typeof a.limit === "number" ? a.limit : undefined,
      });
    },
    async example(arg) {
      const e = getCatalogEntry(gw.catalog, str(obj(arg, "example").id, "id"));
      const { exampleSource, ...rest } = e;
      return { ...rest, source: exampleSource };
    },
    async preview(arg, ctx) {
      const id = str(obj(arg, "preview").id, "id");
      const png = gw.artifacts(ctx.principal, id).find((a) => a.format === "PNG");
      if (!png) {
        throw new CadToolError("NOT_FOUND", "No PNG preview for this job: include 'PNG' in outputs and make sure the job completed.");
      }
      // Marker object: the execute tool swaps it for MCP image content after the program ends.
      return { [PREVIEW_MARKER]: { jobId: id, artifactId: png.artifactId }, sizeBytes: png.sizeBytes };
    },
    async version() {
      return { bridgeApi: BRIDGE_API_VERSION, server: SERVER_ID, catalog: gw.catalog.meta(), freecad: await gw.freecadVersion() };
    },
  };
}

/** Guest-side API documentation (served verbatim in the `execute` tool description; keep it static). */
export const BRIDGE_DOC = `declare const cad: {
  run(req: JobRequest & { options?: { timeoutMs?: number; full?: boolean } }): Promise<Compact>; // submit + wait
  submit(req: JobRequest): Promise<{ id: string; status: string }>;   // max 8 jobs per execute
  wait(id: string, o?: { timeoutMs?: number; compact?: boolean }): Promise<JobResult>;
  result(id: string, o?: { full?: boolean }): Promise<Compact | JobResult>;
  compare(a: string, b: string): Promise<{ bboxMm; volumeMm3; massG; holes; checksFixed; checksNewlyFailing }>;
  preview(id: string): Promise<Marker>; // put the marker in your return value -> the PNG render is attached as an image (max 3)
  search(query: string, o?: { kind?: 'example'|'api'|'pitfall'|'contract'; module?: string; tags?: string[]; limit?: number }): Promise<Hits>;
  example(id: string): Promise<{ id; title; summary; parameters; validationExample; source }>;
  status(id: string): Promise<JobResult>; cancel(id: string): Promise<{ id; status }>;
  artifacts(id: string): Promise<{ artifactId; name; format; sizeBytes; sha256; resourceUri }[]>;
  logs(id: string, o?: { phase?: 'build'|'verify'; stream?: 'stderr'|'stdout'; maxBytes?: number }): Promise<string>;
  version(): Promise<{ bridgeApi; freecad; catalog }>;
};
type JobRequest =
  | { script: string; outputs?: Format[]; parameters?: Params; validation?: Validation; timeoutSec?: number; idempotencyKey?: string }
  | { exampleId: string; parameters?: Params; patch?: Patch[]; outputs?: Format[]; validation?: Validation } // catalog example; without validation, its validationExample is used (only dimension-independent parts if parameters change)
  | { fromJob: string; parameters?: Params; patch?: Patch[]; outputs?: Format[]; validation?: Partial<Validation> }; // variant/repair: script + params + validation reused, validation shallow-merged
type Patch = { find: string; replace: string };  // exact text, must occur once in the script
type Format = 'FCStd'|'STEP'|'STL'|'PNG';         // default for exampleId: ['FCStd','STEP']; PNG needs FCStd or STEP
type Compact = { id; status; ok: boolean; checks?: { passed; total }; failed?: { name; expected; actual; message }[];
  geometry?: { bbox; volume; solids; valid }; massG?; artifacts?: { id; format; bytes }[]; preview?: boolean; error?: { code; message; hint; traceback? } };
type Validation = { requireValidShape?; requireSolid?; expectedBoundingBoxMm?: [x,y,z]; toleranceMm?; expectedVolumeMm3?; volumeTolerancePct?;
  expectedSolidCount?; requireParametric?; requireFullyConstrained?; holes?: { diameterMm; centersMm: [a,b][]; axis?: 'x'|'y'|'z'; reference?: 'bboxMin'|'origin'; through? }[];
  expectedHoleCount?; reportHoles?; material?: 'aluminum_6061'|'steel'|'stainless_304'|'brass'|'copper'|'titanium'|'abs'|'pla'|'petg'|'nylon'|'polycarbonate'|'acetal';
  maxMassG?; flexTests?: { name?; set: Record<alias, number|string>; expect?: { boundingBoxMm?; volumeMm3?; holeCount? } }[] /* needs FCStd */ };
Python job scripts get App, Part, Sketcher, params and cadkit (vetted helpers; search 'cadkit') and must set doc + result_obj.
Errors thrown by cad.* carry .code and .hint. No fs/network/require/fetch/timers; console.log is captured.

Canonical one-call patterns:
1. Build + validate + look:   const r = await cad.run({ exampleId: 'example.cadkit.mounting_plate', parameters: { length: 150 },
     outputs: ['FCStd','STEP','PNG'], validation: { expectedBoundingBoxMm: [150,80,10] } }); return { r, img: r.ok && await cad.preview(r.id) };
2. Repair without resending the script:   return cad.run({ fromJob: id, patch: [{ find: 'edge=12', replace: 'edge=15' }] });
3. Sweep variants in parallel and rank:   const rs = await Promise.all(['M4','M5','M6'].map(b => cad.run({ fromJob: id, parameters: { bolt: b } })));
     return rs.map(r => ({ id: r.id, ok: r.ok, massG: r.massG, failed: r.failed?.length ?? 0 }));
4. Edit-verify:   const v2 = await cad.run({ fromJob: id, parameters: { thickness: 8 } }); return cad.compare(id, v2.id);`;
