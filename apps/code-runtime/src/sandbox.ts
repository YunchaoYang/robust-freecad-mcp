import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { toStructuredError } from "../../../packages/shared/errors.js";
import type { BridgeContext, BridgeMethod } from "./cad-bridge.js";
import { resolveLimits, Semaphore, type ExecutionLimits } from "./limits.js";

/**
 * Restricted JavaScript Code Mode runtime.
 *
 * Each `execute` gets a fresh QuickJS (WebAssembly) runtime + context:
 *  - no filesystem, network, timers, require/import, process or host objects;
 *  - the only capability is the frozen `cad` object, whose methods marshal
 *    JSON strings to an allowlisted host bridge (createBridge);
 *  - heap, stack, wall time (interrupt handler + host race), bridge-call count,
 *    concurrency, submit count, argument size, log size and output size are bounded.
 */

export interface ExecuteOutcome {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; hint?: string; stack?: string; preview?: string };
  logs: string[];
  stats: { durationMs: number; bridgeCalls: number; submittedJobs: string[] };
}

const PRELUDE = `
(() => {
  const hostCall = globalThis.__hostCall;
  const hostLog = globalThis.__hostLog;
  delete globalThis.__hostCall;
  delete globalThis.__hostLog;
  const call = (method, arg) =>
    hostCall(method, JSON.stringify(arg === undefined ? null : arg)).then((s) => {
      const r = JSON.parse(s);
      if (r.ok) return r.value;
      const e = new Error(r.error.message);
      e.name = "CadError";
      e.code = r.error.code;
      if (r.error.hint) e.hint = r.error.hint;
      if (r.error.details !== undefined) e.details = r.error.details;
      throw e;
    });
  const opt = (o) => (o && typeof o === "object" ? o : {});
  const cad = {
    submit: (request) => call("submit", request),
    run: (request) => call("run", request),
    result: (id, o) => call("result", { ...opt(o), id }),
    compare: (a, b) => call("compare", { a, b }),
    status: (id, o) => call("status", { ...opt(o), id }),
    wait: (id, o) => call("wait", { ...opt(o), id }),
    cancel: (id) => call("cancel", { id }),
    artifacts: (id) => call("artifacts", { id }),
    logs: (id, o) => call("logs", { ...opt(o), id }),
    search: (query, o) => call("search", { ...opt(o), query: String(query ?? "") }),
    example: (id) => call("example", { id }),
    version: () => call("version", {}),
    preview: (id) => call("preview", { id }),
  };
  const fmt = (args) => args.map((a) => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
  const console = {
    log: (...a) => hostLog("log", fmt(a)),
    info: (...a) => hostLog("log", fmt(a)),
    warn: (...a) => hostLog("warn", fmt(a)),
    error: (...a) => hostLog("error", fmt(a)),
  };
  Object.defineProperty(globalThis, "cad", { value: Object.freeze(cad), writable: false, configurable: false });
  Object.defineProperty(globalThis, "console", { value: Object.freeze(console), writable: false, configurable: false });
})();
`;

/** Accept either an async function expression or a bare async function body. */
export function wrapProgram(code: string): string {
  const trimmed = code.trim();
  const isFn = /^async\s*(\(\s*\)\s*=>|function\b)/.test(trimmed);
  const program = isFn ? `(${trimmed})()` : `(async () => {\n${code}\n})()`;
  return `(async () => { const __v = await ${program}; return __v === undefined ? "null" : JSON.stringify(__v); })()`;
}

function dumpError(ctx: QuickJSContext, h: QuickJSHandle): { name: string; message: string; stack?: string; code?: string; hint?: string } {
  const d: unknown = ctx.dump(h);
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    return {
      name: String(o.name ?? "Error"),
      message: String(o.message ?? JSON.stringify(o)).slice(0, 2000),
      stack: typeof o.stack === "string" ? o.stack.slice(0, 2000) : undefined,
      code: typeof o.code === "string" ? o.code : undefined,
      hint: typeof o.hint === "string" ? o.hint : undefined,
    };
  }
  return { name: "Error", message: String(d).slice(0, 2000) };
}

export async function runCodeMode(
  code: string,
  bridge: Record<string, BridgeMethod>,
  opts: { principal: string; limits?: Partial<ExecutionLimits>; globals?: Record<string, unknown> },
): Promise<ExecuteOutcome> {
  const limits = resolveLimits(opts.limits);
  const started = Date.now();
  const deadline = started + limits.wallTimeMs;
  const logs: string[] = [];
  let logBytes = 0;
  let logsTruncated = false;
  let bridgeCalls = 0;
  const submittedJobs: string[] = [];
  const abort = new AbortController();
  const sem = new Semaphore(limits.maxConcurrentBridgeCalls);
  const bctx: BridgeContext = {
    principal: opts.principal,
    remainingMs: () => deadline - Date.now(),
    signal: abort.signal,
    limits,
    counters: { submits: 0 },
    submittedJobs,
  };
  const stats = () => ({ durationMs: Date.now() - started, bridgeCalls, submittedJobs: [...submittedJobs] });

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const ctx = runtime.newContext();
  const pending = new Set<QuickJSDeferredPromise>();
  let disposed = false;

  const pump = () => {
    if (disposed) return;
    const r = runtime.executePendingJobs();
    if ("error" in r && r.error) r.error.dispose();
  };

  const settle = (deferred: QuickJSDeferredPromise, envelope: unknown) => {
    pending.delete(deferred);
    if (disposed) return;
    let text: string;
    try {
      text = JSON.stringify(envelope);
    } catch (e) {
      text = JSON.stringify({ ok: false, error: toStructuredError(e) });
    }
    const h = ctx.newString(text);
    deferred.resolve(h);
    h.dispose();
    pump();
  };

  const hostCall = ctx.newFunction("__hostCall", (methodH, argH) => {
    const method = ctx.getString(methodH);
    const argText = ctx.getString(argH);
    const deferred = ctx.newPromise();
    pending.add(deferred);
    const fail = (code: string, message: string) => settle(deferred, { ok: false, error: { code, message } });
    bridgeCalls++;
    if (!Object.prototype.hasOwnProperty.call(bridge, method)) {
      queueMicrotask(() => fail("INVALID_REQUEST", `Unknown cad method '${method}'`));
    } else if (bridgeCalls > limits.maxBridgeCalls) {
      queueMicrotask(() => fail("BUDGET_EXCEEDED", `More than ${limits.maxBridgeCalls} cad.* calls in one execute.`));
    } else if (argText.length > limits.maxBridgeArgBytes) {
      queueMicrotask(() => fail("INVALID_REQUEST", `Argument to cad.${method} exceeds ${limits.maxBridgeArgBytes} bytes.`));
    } else {
      void (async () => {
        const release = await sem.acquire();
        try {
          if (abort.signal.aborted) throw new Error("execution ended");
          const value = await bridge[method](JSON.parse(argText), bctx);
          settle(deferred, { ok: true, value: value === undefined ? null : value });
        } catch (e) {
          settle(deferred, { ok: false, error: toStructuredError(e) });
        } finally {
          release();
        }
      })();
    }
    return deferred.handle;
  });
  const hostLog = ctx.newFunction("__hostLog", (levelH, msgH) => {
    if (logsTruncated) return;
    const level = ctx.getString(levelH);
    const msg = ctx.getString(msgH);
    const line = level === "log" ? msg : `[${level}] ${msg}`;
    if (logBytes + line.length > limits.maxLogBytes) {
      logs.push(line.slice(0, Math.max(0, limits.maxLogBytes - logBytes)) + " …[log budget exhausted]");
      logsTruncated = true;
      return;
    }
    logBytes += line.length;
    logs.push(line);
  });
  ctx.setProp(ctx.global, "__hostCall", hostCall);
  ctx.setProp(ctx.global, "__hostLog", hostLog);
  hostCall.dispose();
  hostLog.dispose();

  const cleanup = () => {
    abort.abort();
    disposed = true;
    for (const d of pending) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    pending.clear();
    try {
      ctx.dispose();
      runtime.dispose();
    } catch {
      /* QuickJS may assert on leaked handles after an abort; the instance is discarded anyway */
    }
  };

  try {
    const pre = ctx.evalCode(PRELUDE, "prelude.js");
    if ("error" in pre && pre.error) {
      const e = dumpError(ctx, pre.error);
      pre.error.dispose();
      return { ok: false, error: { code: "INTERNAL", message: `prelude failed: ${e.message}` }, logs, stats: stats() };
    }
    pre.value.dispose();

    // Read-only data globals (e.g. the catalog for search-as-code): deep-frozen JSON copies.
    for (const [name, value] of Object.entries(opts.globals ?? {})) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
      const src = `(() => { const f = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(f); Object.freeze(o); } return o; };
        Object.defineProperty(globalThis, ${JSON.stringify(name)}, { value: f(JSON.parse(${JSON.stringify(JSON.stringify(value))})), writable: false, configurable: false }); })()`;
      const g = ctx.evalCode(src, "globals.js");
      if ("error" in g && g.error) {
        g.error.dispose();
        return { ok: false, error: { code: "INTERNAL", message: `failed to inject ${name}` }, logs, stats: stats() };
      }
      g.value.dispose();
    }

    const evalRes = ctx.evalCode(wrapProgram(code), "program.js");
    if ("error" in evalRes && evalRes.error) {
      const e = dumpError(ctx, evalRes.error);
      evalRes.error.dispose();
      return { ok: false, error: classify(e), logs, stats: stats() };
    }
    const promiseHandle = evalRes.value;
    const settled = ctx.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    pump();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      settled.then((r) => ("error" in r && r.error ? r.error.dispose() : r.value.dispose())).catch(() => undefined);
      return {
        ok: false,
        error: {
          code: "BUDGET_EXCEEDED",
          message: `Program exceeded wall time of ${limits.wallTimeMs} ms. Submitted jobs keep running; poll them with job_status.`,
        },
        logs,
        stats: stats(),
      };
    }
    if ("error" in outcome && outcome.error) {
      const e = dumpError(ctx, outcome.error);
      outcome.error.dispose();
      return { ok: false, error: classify(e), logs, stats: stats() };
    }
    const json = ctx.getString(outcome.value);
    outcome.value.dispose();
    if (Buffer.byteLength(json) > limits.maxOutputBytes) {
      return {
        ok: false,
        error: {
          code: "OUTPUT_TOO_LARGE",
          message: `Return value is ${Buffer.byteLength(json)} bytes; limit is ${limits.maxOutputBytes}.`,
          preview: json.slice(0, 1000),
        },
        logs,
        stats: stats(),
      };
    }
    return { ok: true, result: JSON.parse(json) as unknown, logs, stats: stats() };
  } finally {
    cleanup();
  }
}

function classify(e: { name: string; message: string; stack?: string; code?: string; hint?: string }): ExecuteOutcome["error"] {
  if (/interrupted/i.test(e.message)) {
    return { code: "BUDGET_EXCEEDED", message: "Program exceeded its wall-time budget (interrupted while running)." };
  }
  if (/out of memory/i.test(e.message)) return { code: "BUDGET_EXCEEDED", message: "Program exceeded its memory budget." };
  if (/stack overflow/i.test(e.message)) return { code: "BUDGET_EXCEEDED", message: "Program exceeded its stack budget." };
  return {
    code: e.code ?? "CODE_RUNTIME_ERROR",
    message: `${e.name}: ${e.message}`,
    hint: e.hint,
    stack: e.stack,
  };
}
