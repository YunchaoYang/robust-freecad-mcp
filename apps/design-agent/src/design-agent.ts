/**
 * Embedded pi design agent: "plain-English request in, verified part out".
 *
 * Three isolated pi sessions, none with built-in tools (no bash/read/write/edit,
 * no MCP servers, no user extensions, skills or context files):
 *
 *   1. spec     - turns the request into a validation spec (the acceptance test)
 *                 BEFORE any geometry exists. The server locks this spec.
 *   2. build    - writes Code Mode programs against the `cad` bridge. Every job it
 *                 submits gets the locked spec overlaid, so the builder can add
 *                 checks but never weaken the acceptance test (no grading its own homework).
 *   3. review   - looks at the rendered PNG and judges whether it matches the request.
 *                 Mismatches go back to the builder while iterations remain.
 *
 * Budgets: tool iterations, USD (summed from provider usage), wall time. Model API
 * credentials stay in this process; they never reach QuickJS or the FreeCAD worker.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CadToolError, toStructuredError } from "../../../packages/shared/errors.js";
import { ValidationSpecSchema, type CadJobResult, type ValidationSpec } from "../../../packages/shared/types.js";
import type { CadGateway } from "../../cad-gateway/src/gateway.js";
import { BRIDGE_DOC, compact, createBridge, type BridgeMethod, type CompactResult } from "../../code-runtime/src/cad-bridge.js";
import { getCatalogEntry, searchCatalog } from "../../code-runtime/src/catalog-view.js";
import { resolveLimits } from "../../code-runtime/src/limits.js";
import { runCodeMode } from "../../code-runtime/src/sandbox.js";
import { attachPreviews } from "../../mcp-server/src/tools/previews.js";

type PiModel = NonNullable<Parameters<typeof createAgentSession>[0]>["model"];

export type DesignThinking = "off" | "minimal" | "low" | "medium" | "high";

export interface DesignModel {
  modelRuntime: ModelRuntime;
  model: NonNullable<PiModel>;
  thinkingLevel?: DesignThinking;
}

/**
 * codemode: builder writes JS programs against the `cad` bridge (exampleId/fromJob/patch, compact results).
 * classic:  ablation baseline - conventional tool calling: fetch full example source, submit full scripts,
 *           read full results; one tool call per step. Same locked spec, review and budgets.
 */
export type ToolMode = "codemode" | "classic";

export interface DesignOptions {
  maxIterations: number;
  budgetUsd: number;
  visualCheck: boolean;
  wallTimeMs: number;
  toolMode: ToolMode;
}

export const DEFAULT_DESIGN_OPTIONS: DesignOptions = { maxIterations: 4, budgetUsd: 1, visualCheck: true, wallTimeMs: 15 * 60_000, toolMode: "codemode" };

type Stage = "spec" | "build" | "review";

export type DesignStatus = "running" | "succeeded" | "failed" | "budget_exhausted" | "cancelled";

export interface DesignEvent {
  ts: string;
  stage: "spec" | "build" | "review" | "done";
  message: string;
}

export interface DesignRecord {
  id: string;
  status: DesignStatus;
  request: string;
  model: string;
  validationSpec?: ValidationSpec;
  specNotes?: string;
  jobId?: string;
  result?: CompactResult;
  visualReview?: { matches: boolean; issues: string[] }[];
  iterations: number;
  toolMode?: ToolMode;
  /** Model round trips (assistant messages) per stage. */
  modelCalls?: Record<Stage, number>;
  /** Wall time per stage. */
  stageMs?: Record<Stage, number>;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  durationMs: number;
  events: DesignEvent[];
  error?: { code: string; message: string; hint?: string };
  summary?: string;
}

/**
 * A self-hosted OpenAI-compatible endpoint (vLLM, SGLang, llama.cpp, ...), e.g.
 *   FREECAD_MCP_DESIGN_BASE_URL=http://localhost:8000/v1  FREECAD_MCP_DESIGN_MODEL=Qwen3.8-27B
 * Uses a private model runtime (no ~/.pi credentials are read or written).
 */
export async function localDesignModel(baseUrl: string, id?: string): Promise<DesignModel> {
  const url = baseUrl.replace(/\/+$/, "");
  const apiKey = process.env.FREECAD_MCP_DESIGN_API_KEY ?? "none";
  let modelId = id;
  let contextWindow = Number(process.env.FREECAD_MCP_DESIGN_CONTEXT ?? 0) || 0;
  try {
    const r = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
    const list = ((await r.json()) as { data?: { id: string; max_model_len?: number }[] }).data ?? [];
    const hit = modelId ? list.find((m) => m.id === modelId) : list[0];
    if (!hit) throw new Error(modelId ? `model '${modelId}' not served; available: ${list.map((m) => m.id).join(", ")}` : "server lists no models");
    modelId = hit.id;
    contextWindow ||= hit.max_model_len ?? 0;
  } catch (e) {
    throw new CadToolError("DESIGN_UNAVAILABLE", `Local model endpoint ${url} unusable: ${(e as Error).message}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fcmcp-local-model-"));
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const vision = process.env.FREECAD_MCP_DESIGN_VISION !== "0";
  const thinkingFormat = process.env.FREECAD_MCP_DESIGN_THINKING_FORMAT ?? (/qwen/i.test(modelId) ? "qwen-chat-template" : undefined);
  modelRuntime.registerProvider("local", {
    api: "openai-completions",
    baseUrl: url,
    apiKey,
    models: [
      {
        id: modelId,
        name: modelId,
        input: vision ? ["text", "image"] : ["text"],
        reasoning: true,
        contextWindow: contextWindow || 32_768,
        // Bound single generations: a 16k-token reply takes >10 min on a local GPU and stalled eval runs.
        maxTokens: Number(process.env.FREECAD_MCP_DESIGN_MAX_TOKENS ?? 0) || Math.min(8_192, Math.floor((contextWindow || 32_768) / 4)),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsReasoningEffort: false, ...(thinkingFormat ? { thinkingFormat } : {}) },
      },
    ],
  } as never);
  const model = modelRuntime.getModel("local", modelId!);
  if (!model) throw new CadToolError("DESIGN_UNAVAILABLE", `Failed to register local model ${modelId}.`);
  return { modelRuntime, model, thinkingLevel: (process.env.FREECAD_MCP_DESIGN_THINKING as DesignThinking | undefined) ?? "low" };
}

/**
 * Resolve the model: a self-hosted endpoint (FREECAD_MCP_DESIGN_BASE_URL), else
 * FREECAD_MCP_DESIGN_MODEL ("provider/id"), else the first pi model with credentials.
 */
export async function resolveDesignModel(spec = process.env.FREECAD_MCP_DESIGN_MODEL): Promise<DesignModel | null> {
  if (process.env.FREECAD_MCP_DESIGN_BASE_URL) return localDesignModel(process.env.FREECAD_MCP_DESIGN_BASE_URL, spec);
  const modelRuntime = await ModelRuntime.create();
  if (spec) {
    const slash = spec.indexOf("/");
    const model = slash > 0 ? modelRuntime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
    if (!model) throw new CadToolError("DESIGN_UNAVAILABLE", `Model '${spec}' not found. Use 'provider/id' as listed by 'pi --list-models'.`);
    return { modelRuntime, model };
  }
  const available = await modelRuntime.getAvailable();
  return available.length ? { modelRuntime, model: available[0] } : null;
}

// ------------------------------------------------------------------ prompts

const MATERIALS_LINE = "aluminum_6061 | steel | stainless_304 | brass | copper | titanium | abs | pla | petg | nylon | polycarbonate | acetal";

export const SPEC_SYSTEM_PROMPT = `You are a mechanical design reviewer. Convert a part request into an ACCEPTANCE TEST for a CAD validator, before any geometry exists.
Reply with exactly one \`\`\`json block containing {"validation": {...}, "notes": "..."} and nothing else.

"validation" fields (all optional, use only what the request actually determines):
  requireValidShape, requireSolid (default true), expectedSolidCount,
  expectedBoundingBoxMm: [X, Y, Z]   (axis convention: X = length / longest in-plane size, Y = width, Z = thickness / height; the builder will follow it),
  toleranceMm (default 0.01), expectedVolumeMm3 + volumeTolerancePct (only if derivable),
  holes: [{ diameterMm, centersMm: [[a, b], ...], axis: "z", reference: "bboxMin" | "origin", through: true }]  (centres measured from the bounding-box min corner when reference is bboxMin),
  expectedHoleCount, requireParametric, requireFullyConstrained,
  material: ${MATERIALS_LINE}, maxMassG,
  flexTests: [{ name, set: { <spreadsheet alias>: value }, expect: { boundingBoxMm?, holeCount? } }]  (only if the request asks for a robust/parametric model; aliases must be the parameter names you list in notes).

Rules: ISO 273 medium clearance holes: M3 3.4, M4 4.5, M5 5.5, M6 6.6, M8 9.0, M10 11.0, M12 13.5 mm. Tapped-hole tap drills: M3 2.5, M4 3.3, M5 4.2, M6 5.0, M8 6.8.
If the request is ambiguous, choose the most conventional reading and state it in notes. "notes" (<= 600 chars) tells the builder the axis layout, parameter names and any assumptions.`;

export function buildSystemPrompt(maxIterations: number): string {
  return `You are a CAD engineer working through a FreeCAD Code Mode API. You have two tools:
  cad_search - find catalog examples/APIs (prefer cadkit examples; they are short and fully constrained)
  cad_execute - run a JavaScript program with the \`cad\` object (documented below)

Workflow:
1. Search once or twice, then build with ONE cad_execute call that uses cad.run({... outputs: ['FCStd','STEP','PNG'] }).
2. The server overlays a LOCKED acceptance spec on every job; you cannot remove its checks. Make the part satisfy it.
3. If the result is not ok, read failed[] (expected vs actual) and repair with cad.run({ fromJob, patch | parameters }) - do not resend whole scripts.
4. When a job is ok, return cad.preview(job.id) in the same program so you can see the render, then answer with one line: DONE <jobId>.
At most ${maxIterations} cad_execute calls. Build parametric models (spreadsheet/cadkit parameters, constrained sketches). Never ask the user questions.

${BRIDGE_DOC}`;
}

const VALIDATION_TYPE = /type Validation = [\s\S]*?\};/.exec(BRIDGE_DOC)?.[0] ?? "";

export function classicSystemPrompt(maxIterations: number): string {
  return `You are a CAD engineer driving a headless FreeCAD 1.1 server with these tools:
  cad_search(query, kind?)            - find catalog examples/APIs (prefer cadkit examples)
  cad_example(id)                     - full catalog entry including the example script source
  cad_submit(script, outputs?, parameters?) - submit a complete FreeCAD Python script as a job; returns {id, status}
  cad_status(id)                      - wait for the job and return its full result (geometry, all checks, artifacts, error, render image)

Script contract: Python with App/FreeCAD, Part, Sketcher, params (dict of parameters) and cadkit pre-bound. The script must set
\`doc\` (App.newDocument(...)) and \`result_obj\` (final object with .Shape, e.g. a PartDesign Body). Runs headless (no FreeCADGui).

Workflow:
1. Search, fetch an example if useful, then submit a complete script with outputs ['FCStd','STEP','PNG'].
2. The server overlays a LOCKED acceptance spec on every job; you cannot remove its checks. Make the part satisfy it.
3. Call cad_status(id). If not completed, read the failed checks (expected vs actual) or the traceback, fix the script and submit the full corrected script again.
4. When a job completes, answer with one line: DONE <jobId>.
At most ${maxIterations} cad_submit calls. Build parametric models (spreadsheet/cadkit parameters, constrained sketches). Never ask the user questions.

Acceptance spec fields (for reading results):
${VALIDATION_TYPE}`;
}

export const REVIEW_SYSTEM_PROMPT = `You inspect a 4-view CAD render (iso, top, front, right; dimensions annotated) against a part request.
Judge only what is visible: overall shape, feature counts and placement, through vs blind, proportions. Ignore colour and styling.
Reply with exactly one \`\`\`json block: {"matches": true|false, "issues": ["...", ...]} (issues empty when matches).`;

// ------------------------------------------------------------------ helpers

export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body);
}

/** Bridge whose submit/run always carry the locked acceptance spec and the required outputs. */
export function lockedBridge(base: Record<string, BridgeMethod>, locked: ValidationSpec): Record<string, BridgeMethod> {
  const REQUIRED = ["FCStd", "STEP", "PNG"];
  const lock = (fn: BridgeMethod): BridgeMethod => async (arg, ctx) => {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) return fn(arg, ctx);
    const a = { ...(arg as Record<string, unknown>) };
    a.validation = { ...((a.validation as object) ?? {}), ...locked };
    if (Array.isArray(a.outputs)) a.outputs = [...new Set([...(a.outputs as string[]), ...REQUIRED])];
    else if (a.fromJob === undefined) a.outputs = REQUIRED;
    return fn(a, ctx);
  };
  return { ...base, submit: lock(base.submit), run: lock(base.run) };
}

// ------------------------------------------------------------------ the agent

export class DesignAgent {
  private readonly sessions: AgentSession[] = [];
  private aborted: DesignStatus | null = null;

  constructor(
    private readonly gw: CadGateway,
    private readonly principal: string,
    private readonly dm: DesignModel,
    private readonly record: DesignRecord,
    private readonly opts: DesignOptions,
    private readonly workDir: string,
  ) {}

  abort(reason: DesignStatus = "cancelled"): void {
    this.aborted ??= reason;
    for (const s of this.sessions) void s.abort().catch(() => undefined);
  }

  private event(stage: DesignEvent["stage"], message: string): void {
    this.record.events.push({ ts: new Date().toISOString(), stage, message: message.slice(0, 300) });
  }

  private async newSession(systemPrompt: string, tools: ToolDefinition[], stage: Stage): Promise<AgentSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.workDir,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.workDir,
      model: this.dm.model,
      modelRuntime: this.dm.modelRuntime,
      thinkingLevel: this.dm.thinkingLevel ?? "low",
      tools: tools.length ? tools.map((t) => t.name) : [],
      noTools: tools.length ? "builtin" : "all",
      customTools: tools,
      resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(this.workDir),
    });
    session.subscribe((ev) => {
      if (ev.type !== "message_end" || ev.message.role !== "assistant") return;
      const mc = (this.record.modelCalls ??= { spec: 0, build: 0, review: 0 });
      mc[stage]++;
      const u = ev.message.usage;
      if (!u) return;
      this.record.tokens.input += u.input ?? 0;
      this.record.tokens.output += u.output ?? 0;
      this.record.tokens.cacheRead += u.cacheRead ?? 0;
      this.record.tokens.cacheWrite += u.cacheWrite ?? 0;
      this.record.costUsd = Math.round((this.record.costUsd + (u.cost?.total ?? 0)) * 1e6) / 1e6;
      if (this.record.costUsd > this.opts.budgetUsd) this.abort("budget_exhausted");
    });
    this.sessions.push(session);
    return session;
  }

  private async ask(session: AgentSession, text: string, images?: { type: "image"; data: string; mimeType: string }[]): Promise<string> {
    if (this.aborted) throw new CadToolError("CANCELLED", `design ${this.aborted}`);
    await session.prompt(text, images ? { images } : undefined);
    if (this.aborted) throw new CadToolError("CANCELLED", `design ${this.aborted}`);
    return session.getLastAssistantText() ?? "";
  }

  // ---- stage 1
  private async specify(): Promise<void> {
    this.event("spec", "deriving acceptance spec from the request");
    const s = await this.newSession(SPEC_SYSTEM_PROMPT, [], "spec");
    let text = await this.ask(s, `Part request:\n${this.record.request}`);
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = extractJson(text) as { validation?: unknown; notes?: unknown };
        const parsed = ValidationSpecSchema.safeParse(raw.validation ?? {});
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        this.record.validationSpec = parsed.data;
        this.record.specNotes = typeof raw.notes === "string" ? raw.notes.slice(0, 1000) : undefined;
        this.event("spec", `locked spec: ${JSON.stringify(parsed.data).slice(0, 240)}`);
        return;
      } catch (e) {
        if (attempt >= 1) throw new CadToolError("DESIGN_SPEC_FAILED", `Could not derive a valid acceptance spec: ${(e as Error).message}`);
        text = await this.ask(s, `That was not valid: ${(e as Error).message}. Reply again with only the json block.`);
      }
    }
  }

  // ---- stage 2 tools
  private tools(): ToolDefinition[] {
    const bridge = lockedBridge(createBridge(this.gw), this.record.validationSpec!);
    const searchTool = defineTool({
      name: "cad_search",
      label: "CAD catalog search",
      description: "Search the FreeCAD catalog (examples, API, pitfalls). Returns compact hits with ids.",
      parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.String()) }),
      execute: async (_id, p) => {
        const r = searchCatalog(this.gw.catalog, { query: p.query, kind: p.kind, limit: 5 });
        return { content: [{ type: "text", text: JSON.stringify({ results: r.results }) }], details: {} };
      },
    });
    const execTool = defineTool({
      name: "cad_execute",
      label: "CAD Code Mode",
      description: "Run a JavaScript Code Mode program (async function body; use return) with the `cad` object. See the system prompt for the API.",
      parameters: Type.Object({ code: Type.String() }),
      execute: async (_id, p, signal) => {
        if (this.record.iterations >= this.opts.maxIterations) {
          return {
            content: [{ type: "text", text: `Iteration budget (${this.opts.maxIterations}) exhausted. Stop and reply DONE <bestJobId> or FAILED <reason>.` }],
            details: {},
            isError: true,
          };
        }
        this.record.iterations++;
        const out = await runCodeMode(p.code, bridge, { principal: this.principal, limits: { wallTimeMs: 300_000 } });
        void signal;
        for (const id of out.stats.submittedJobs) this.event("build", `iteration ${this.record.iterations}: submitted ${id}`);
        if (!out.stats.submittedJobs.length) {
          const why = out.ok ? "program returned without submitting a job" : `${out.error?.code}: ${out.error?.message ?? ""}`;
          this.event("build", `iteration ${this.record.iterations}: no job (${why})`);
        }
        if (!out.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: out.error, logs: out.logs }) }], details: {}, isError: true };
        }
        const { value, images } = attachPreviews(this.gw, this.principal, out.result);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, result: value, logs: out.logs }) }, ...images], details: {} };
      },
    });
    return [searchTool, execTool] as ToolDefinition[];
  }

  // ---- stage 2 tools, ablation baseline: conventional one-call-per-step tools
  private classicTools(): ToolDefinition[] {
    const bridge = lockedBridge(createBridge(this.gw), this.record.validationSpec!);
    const ctx = {
      principal: this.principal,
      remainingMs: () => 300_000,
      signal: new AbortController().signal,
      limits: resolveLimits({ maxSubmits: 1000 }),
      counters: { submits: 0 },
      submittedJobs: [] as string[],
    };
    const text = (v: unknown) => ({ type: "text" as const, text: JSON.stringify(v) });
    const searchTool = defineTool({
      name: "cad_search",
      label: "CAD catalog search",
      description: "Search the FreeCAD catalog (examples, API, pitfalls). Returns compact hits with ids.",
      parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.String()) }),
      execute: async (_id, p) => ({ content: [text({ results: searchCatalog(this.gw.catalog, { query: p.query, kind: p.kind, limit: 5 }).results })], details: {} }),
    });
    const exampleTool = defineTool({
      name: "cad_example",
      label: "CAD example",
      description: "Fetch one catalog entry in full, including its example script source.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, p) => {
        try {
          return { content: [text(getCatalogEntry(this.gw.catalog, p.id))], details: {} };
        } catch (e) {
          return { content: [text({ error: toStructuredError(e) })], details: {}, isError: true };
        }
      },
    });
    const submitTool = defineTool({
      name: "cad_submit",
      label: "CAD submit",
      description: "Submit a complete FreeCAD Python script as a job. Returns {id, status}. Use cad_status to get the result.",
      parameters: Type.Object({
        script: Type.String(),
        outputs: Type.Optional(Type.Array(Type.String())),
        parameters: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String(), Type.Boolean()]))),
      }),
      execute: async (_id, p) => {
        if (this.record.iterations >= this.opts.maxIterations) {
          return { content: [{ type: "text", text: `Submission budget (${this.opts.maxIterations}) exhausted. Stop and reply DONE <bestJobId> or FAILED <reason>.` }], details: {}, isError: true };
        }
        this.record.iterations++;
        try {
          const r = (await bridge.submit({ script: p.script, outputs: p.outputs, parameters: p.parameters }, ctx)) as { id: string };
          this.event("build", `iteration ${this.record.iterations}: submitted ${r.id}`);
          return { content: [text(r)], details: {} };
        } catch (e) {
          this.event("build", `iteration ${this.record.iterations}: no job (${toStructuredError(e).code})`);
          return { content: [text({ error: toStructuredError(e) })], details: {}, isError: true };
        }
      },
    });
    const statusTool = defineTool({
      name: "cad_status",
      label: "CAD status",
      description: "Wait for a job to finish and return its full result (geometry, every check, artifacts, error) plus its render.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, p) => {
        try {
          const r = await this.gw.wait(this.principal, p.id, 300_000);
          const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [text(r)];
          const png = r.artifacts?.find((a) => a.format === "PNG");
          if (png) {
            const { file } = this.gw.artifactFile(this.principal, r.id, png.artifactId);
            content.push({ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" });
          }
          return { content, details: {} };
        } catch (e) {
          return { content: [text({ error: toStructuredError(e) })], details: {}, isError: true };
        }
      },
    });
    return [searchTool, exampleTool, submitTool, statusTool] as ToolDefinition[];
  }

  /** Best job: the most recent completed job (all locked checks passed), else the most recent job. */
  private pickJob(): CadJobResult | undefined {
    const ids = this.record.events.flatMap((e) => /submitted (job_[\w-]+)/.exec(e.message)?.[1] ?? []);
    const results = ids.map((id) => this.gw.status(this.principal, id));
    return [...results].reverse().find((r) => r.status === "completed") ?? results.at(-1);
  }

  // ---- stage 3
  private async review(job: CadJobResult): Promise<{ matches: boolean; issues: string[] } | undefined> {
    const png = job.artifacts?.find((a) => a.format === "PNG");
    if (!png) return undefined;
    const { file } = this.gw.artifactFile(this.principal, job.id, png.artifactId);
    const image = { type: "image" as const, data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" };
    const s = await this.newSession(REVIEW_SYSTEM_PROMPT, [], "review");
    const text = await this.ask(s, `Part request:\n${this.record.request}\n\nDesigner notes: ${this.record.specNotes ?? "-"}`, [image]);
    try {
      const r = extractJson(text) as { matches?: unknown; issues?: unknown };
      return { matches: r.matches === true, issues: Array.isArray(r.issues) ? r.issues.map(String).slice(0, 10) : [] };
    } catch {
      return { matches: false, issues: [`unparseable review: ${text.slice(0, 200)}`] };
    }
  }

  async run(): Promise<void> {
    const t0 = Date.now();
    const timer = setTimeout(() => this.abort("cancelled"), this.opts.wallTimeMs);
    const classic = this.opts.toolMode === "classic";
    this.record.toolMode = this.opts.toolMode;
    const stageMs = (this.record.stageMs = { spec: 0, build: 0, review: 0 });
    const timed = async <T>(stage: Stage, fn: () => Promise<T>): Promise<T> => {
      const s0 = Date.now();
      try {
        return await fn();
      } finally {
        stageMs[stage] += Date.now() - s0;
      }
    };
    try {
      await timed("spec", () => this.specify());
      this.event("build", `building against the locked spec (${this.opts.toolMode})`);
      const builder = await this.newSession(
        classic ? classicSystemPrompt(this.opts.maxIterations) : buildSystemPrompt(this.opts.maxIterations),
        classic ? this.classicTools() : this.tools(),
        "build",
      );
      let reply = await timed("build", () =>
        this.ask(
          builder,
          `Part request:\n${this.record.request}\n\nLocked acceptance spec (overlaid on every job):\n${JSON.stringify(this.record.validationSpec)}\n\nSpec notes: ${this.record.specNotes ?? "-"}`,
        ),
      );
      let job = this.pickJob();
      for (let round = 0; this.opts.visualCheck && job?.status === "completed" && round < 2; round++) {
        this.event("review", `visual review of ${job.id}`);
        const reviewed = job;
        const verdict = await timed("review", () => this.review(reviewed));
        if (!verdict) break;
        (this.record.visualReview ??= []).push(verdict);
        if (verdict.matches || this.record.iterations >= this.opts.maxIterations) break;
        this.event("review", `mismatch: ${verdict.issues.join("; ")}`);
        const fix = classic
          ? `submit a corrected full script with cad_submit, check it with cad_status`
          : `cad.run({ fromJob: '${job.id}', ... })`;
        reply = await timed("build", () =>
          this.ask(builder, `A reviewer looked at the render of ${reviewed.id} and found: ${verdict.issues.join("; ")}. Fix these with ${fix} and reply DONE <jobId>.`),
        );
        job = this.pickJob();
      }
      this.record.summary = reply.slice(0, 500);
      if (job) {
        this.record.jobId = job.id;
        this.record.result = compact(job);
      }
      const visualOk = !this.record.visualReview?.length || this.record.visualReview.at(-1)!.matches;
      this.record.status = job?.status === "completed" && visualOk ? "succeeded" : "failed";
      if (this.record.status === "failed" && !this.record.error) {
        this.record.error = job
          ? { code: job.status === "completed" ? "VISUAL_MISMATCH" : (job.error?.code ?? "VALIDATION_FAILED"), message: job.status === "completed" ? "Render did not match the request." : (job.error?.message ?? "No passing job.") }
          : { code: "NO_JOB", message: "The design agent did not submit any job." };
      }
    } catch (e) {
      this.record.status = this.aborted ?? "failed";
      const err = toStructuredError(e);
      this.record.error = this.aborted === "budget_exhausted" ? { code: "BUDGET_EXCEEDED", message: `Spent $${this.record.costUsd} of $${this.opts.budgetUsd}.` } : err;
      const job = this.pickJob();
      if (job) {
        this.record.jobId = job.id;
        this.record.result = compact(job);
      }
    } finally {
      clearTimeout(timer);
      if (this.aborted && this.record.status === "running") this.record.status = this.aborted;
      this.record.durationMs = Date.now() - t0;
      this.event("done", `${this.record.status} in ${this.record.durationMs} ms, $${this.record.costUsd}`);
      for (const s of this.sessions) {
        try {
          s.dispose();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export function newDesignWorkDir(dataDir: string, id: string): string {
  const dir = path.join(dataDir, "designs", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
