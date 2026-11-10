import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeMethod } from "../../apps/code-runtime/src/cad-bridge.js";
import { runCodeMode } from "../../apps/code-runtime/src/sandbox.js";
import { CadToolError } from "../../packages/shared/errors.js";

const calls: string[] = [];
const fake: Record<string, BridgeMethod> = {
  async search(arg) { calls.push("search"); return { echo: arg }; },
  async status(arg) { const a = arg as { id: string }; if (a.id === "missing") throw new CadToolError("NOT_FOUND", "Unknown job id."); return { id: a.id, status: "completed" }; },
  async wait(arg) { await new Promise((r) => setTimeout(r, 50)); return { id: (arg as { id: string }).id, status: "completed" }; },
  async submit(_arg, ctx) { ctx.counters.submits++; return { id: "job_x", status: "queued" }; },
};
const run = (code: string, limits = {}) => runCodeMode(code, fake, { principal: "t", limits });

test("returns JSON result from function body and from async arrow", async () => {
  assert.deepEqual((await run("return 1 + 1")).result, 2);
  assert.deepEqual((await run("async () => ({ a: [1, 2] })")).result, { a: [1, 2] });
  assert.equal((await run("const x = 1;")).result, null);
});

test("no ambient capabilities: fs, network, process, require, timers, host globals", async () => {
  const r = await run(`return {
    require: typeof require, process: typeof process, fetch: typeof fetch, XMLHttpRequest: typeof XMLHttpRequest,
    std: typeof std, os: typeof os, setTimeout: typeof setTimeout, Deno: typeof Deno, Bun: typeof Bun,
    hostCall: typeof __hostCall, hostLog: typeof __hostLog, globalKeys: Object.getOwnPropertyNames(globalThis).filter(k => /host|require|process/i.test(k)),
  }`);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const v = r.result as Record<string, unknown>;
  for (const k of ["require", "process", "fetch", "XMLHttpRequest", "std", "os", "setTimeout", "Deno", "Bun", "hostCall", "hostLog"]) assert.equal(v[k], "undefined", k);
  assert.deepEqual(v.globalKeys, []);
  const imp = await run(`const m = await import("os"); return 1`);
  assert.equal(imp.ok, false);
});

test("cad bridge is frozen and only allowlisted methods exist", async () => {
  const r = await run(`"use strict"; let replaced = true; try { cad.submit = () => 1; } catch { replaced = false; } return { keys: Object.keys(cad).sort(), replaced, frozen: Object.isFrozen(cad) }`);
  assert.deepEqual(r.result, { keys: ["artifacts", "cancel", "compare", "example", "logs", "preview", "result", "run", "search", "status", "submit", "version", "wait"], replaced: false, frozen: true });
  const unk = await run(`try { await cad.wait("x"); } catch (e) {} return "ok"`);
  assert.equal(unk.ok, true);
});

test("structured errors propagate with code and hint", async () => {
  const r = await run(`try { await cad.status("missing"); } catch (e) { return { name: e.name, code: e.code, hint: e.hint, message: e.message } }`);
  assert.deepEqual((r.result as { code: string }).code, "NOT_FOUND");
  assert.ok((r.result as { hint: string }).hint);
  const unhandled = await run(`await cad.status("missing")`);
  assert.equal(unhandled.ok, false);
  assert.equal(unhandled.error?.code, "NOT_FOUND");
  const thrown = await run(`throw new TypeError("boom")`);
  assert.equal(thrown.error?.code, "CODE_RUNTIME_ERROR");
  assert.match(thrown.error!.message, /TypeError: boom/);
});

test("loops, conditionals and bounded parallelism work", async () => {
  const r = await run(`
    const ids = ["a","b","c","d","e","f"];
    const res = await Promise.all(ids.map((id) => cad.wait(id)));
    let n = 0; for (const x of res) if (x.status === "completed") n++;
    return n;`);
  assert.equal(r.result, 6);
  assert.equal(r.stats.bridgeCalls, 6);
  // 6 calls x 50 ms with max 4 concurrent -> at least 2 waves
  assert.ok(r.stats.durationMs >= 95, String(r.stats.durationMs));
});

test("CPU busy loop is interrupted by the wall-time budget", async () => {
  const r = await run("while (true) {}", { wallTimeMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "BUDGET_EXCEEDED");
});

test("awaiting forever is cut off by the host deadline", async () => {
  const r = await run("await new Promise(() => {}); return 1", { wallTimeMs: 1000 });
  assert.equal(r.error?.code, "BUDGET_EXCEEDED");
});

test("memory budget", async () => {
  const r = await run("const a = []; while (true) a.push('x'.repeat(1e5) + a.length);", { memoryBytes: 8 * 1024 * 1024, wallTimeMs: 10000 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "BUDGET_EXCEEDED", JSON.stringify(r.error));
});

test("bridge call count budget", async () => {
  const r = await run("for (let i = 0; i < 10; i++) await cad.search('x'); return 1", { maxBridgeCalls: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "BUDGET_EXCEEDED");
});

test("output and log size limits", async () => {
  const big = await run("return 'x'.repeat(100000)", { maxOutputBytes: 1000 });
  assert.equal(big.error?.code, "OUTPUT_TOO_LARGE");
  const logs = await run("for (let i = 0; i < 1000; i++) console.log('line ' + i); return 1", { maxLogBytes: 200 });
  assert.equal(logs.ok, true);
  assert.ok(logs.logs.join("\n").length < 300);
  assert.match(logs.logs.at(-1)!, /log budget exhausted/);
});

test("syntax errors are reported", async () => {
  const r = await run("return {");
  assert.equal(r.ok, false);
  assert.match(r.error!.message, /SyntaxError/);
});

test("applyPatches: exact, unique, all-or-error", async () => {
  const { applyPatches } = await import("../../apps/code-runtime/src/cad-bridge.js");
  assert.equal(applyPatches("a=1\nb=2", [{ find: "b=2", replace: "b=3" }]), "a=1\nb=3");
  assert.throws(() => applyPatches("x x", [{ find: "x", replace: "y" }]), /more than once/);
  assert.throws(() => applyPatches("abc", [{ find: "zzz", replace: "y" }]), /not found/);
  assert.throws(() => applyPatches("abc", [{ find: "", replace: "y" }]), /non-empty/);
});
