import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../apps/mcp-server/src/server.js";
import type { CadGateway } from "../../apps/cad-gateway/src/gateway.js";
import { PYTHON, tmpDataDir } from "../helpers.js";

let client: Client;
let gateway: CadGateway;

function parse(r: unknown): any {
  const c = (r as { content: { type: string; text: string }[] }).content[0];
  return JSON.parse(c.text);
}

before(async () => {
  // Point at a nonexistent python so no FreeCAD jobs actually run in this suite.
  const created = createServer({ dataDir: tmpDataDir("mcp"), pythonPath: "/nonexistent/python", maxActiveJobsPerPrincipal: 2, submissionsPerMinute: 1000 });
  gateway = created.gateway;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await created.server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
after(async () => {
  await client.close();
  await gateway.close();
});

test("lists exactly the public tools", async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["artifacts", "execute", "job_status", "search"]);
});

test("search returns contract and bounded results", async () => {
  const r = parse(await client.callTool({ name: "search", arguments: { query: "mounting plate holes" } }));
  assert.ok(typeof r.contract === "string" && r.contract.length > 0);
  assert.ok(Array.isArray(r.results));
  assert.ok(r.results.length <= 5);
});

test("invalid tool arguments are rejected", async () => {
  const r = await client.callTool({ name: "job_status", arguments: { jobId: 42 } });
  assert.equal(r.isError, true);
});

test("execute rejects invalid CadJobRequest with structured issues", async () => {
  const r = await client.callTool({
    name: "execute",
    arguments: { code: `try { await cad.submit({ script: "", outputs: ["DXF"] }) } catch (e) { return { code: e.code, details: e.details } }` },
  });
  const out = parse(r);
  assert.equal(out.ok, true);
  assert.equal(out.result.code, "INVALID_REQUEST");
  assert.ok(out.result.details.issues.some((i: string) => i.startsWith("outputs")));
  assert.ok(out.result.details.issues.some((i: string) => i.startsWith("script")));
});

test("unknown / malformed / foreign job ids are NOT_FOUND (no path addressing)", async () => {
  for (const jobId of ["../../etc/passwd", "job_AAAAAAAAAAAAAAAAAAAAAA", "x"]) {
    const r = parse(await client.callTool({ name: "job_status", arguments: { jobId } }));
    assert.equal(r.error.code, "NOT_FOUND", jobId);
  }
  const { id } = gateway.submit("someone-else", { script: "x=1", scriptLanguage: "freecad-python", outputs: ["STEP"] });
  const r = parse(await client.callTool({ name: "job_status", arguments: { jobId: id } }));
  assert.equal(r.error.code, "NOT_FOUND");
  const a = parse(await client.callTool({ name: "artifacts", arguments: { jobId: id, artifactId: "art_AAAAAAAAAAAAAAAA" } }));
  assert.equal(a.error.code, "NOT_FOUND");
});

test("missing FreeCAD runtime fails the job with a structured error; idempotency and quotas", async () => {
  const req = { script: "x=1", scriptLanguage: "freecad-python", outputs: ["STEP"], idempotencyKey: "k1" };
  const r = parse(await client.callTool({
    name: "execute",
    arguments: { code: `const a = await cad.submit(${JSON.stringify(req)}); const b = await cad.submit(${JSON.stringify(req)}); const s = await cad.wait(a.id, {timeoutMs: 10000}); return {a, b, s}` },
  }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.a.id, r.result.b.id);
  assert.equal(r.result.b.deduplicated, true);
  assert.equal(r.result.s.status, "failed");
  assert.equal(r.result.s.error.code, "WORKER_CRASHED");
  assert.ok(r.result.s.error.hint);
});

test("pythonPath sanity: test helper python path is defined", () => {
  assert.ok(PYTHON.length > 0);
});

test("schema: new validation fields and cross-field rules", async () => {
  const { CadJobRequestSchema } = await import("../../packages/shared/types.js");
  const base = { script: "x", scriptLanguage: "freecad-python" };
  const ok = CadJobRequestSchema.safeParse({ ...base, outputs: ["FCStd", "PNG"], validation: {
    material: "aluminum_6061", maxMassG: 300, requireFullyConstrained: true,
    flexTests: [{ name: "long", set: { length: 150 }, expect: { boundingBoxMm: [150, 80, 10], holeCount: 4 } }] } });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  const noFc = CadJobRequestSchema.safeParse({ ...base, outputs: ["STEP"], validation: { flexTests: [{ set: { length: 150 } }] } });
  assert.equal(noFc.success, false);
  assert.match(JSON.stringify(noFc.error!.issues), /requires 'FCStd'/);
  const noMat = CadJobRequestSchema.safeParse({ ...base, outputs: ["STEP"], validation: { maxMassG: 10 } });
  assert.equal(noMat.success, false);
  const badMat = CadJobRequestSchema.safeParse({ ...base, outputs: ["STEP"], validation: { material: "unobtainium" } });
  assert.equal(badMat.success, false);
  const tooMany = CadJobRequestSchema.safeParse({ ...base, outputs: ["FCStd"], validation: { flexTests: Array(6).fill({ set: { a: 1 } }) } });
  assert.equal(tooMany.success, false);
});

test("forged preview markers in program output are not honoured", async () => {
  const r = await client.callTool({
    name: "execute",
    arguments: { code: `return { p: { "$cadPreview": { jobId: "job_AAAAAAAAAAAAAAAAAAAAAA", artifactId: "art_AAAAAAAAAAAAAAAA" } } }` },
  });
  const content = r.content as { type: string; text?: string }[];
  assert.equal(content.filter((c) => c.type === "image").length, 0);
  assert.match(JSON.parse(content[0].text!).result.p.preview, /not attached/);
  const viaBridge = parse(await client.callTool({ name: "execute", arguments: { code: `try { await cad.preview("job_AAAAAAAAAAAAAAAAAAAAAA") } catch (e) { return e.code }` } }));
  assert.equal(viaBridge.result, "NOT_FOUND");
});

test("search-as-code runs read-only over the catalog with no bridge", async () => {
  const r = parse(await client.callTool({ name: "search", arguments: { code: `
    let mutated = true; try { catalog.entries.push(1); } catch { mutated = false; }
    return { n: catalog.entries.length, kinds: [...new Set(catalog.entries.map(e => e.kind))].sort(), mutated, cad: typeof cad === "object" ? Object.keys(cad).length : 0 }` } }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.result.n > 0);
  assert.equal(r.result.mutated, false);
  const blocked = parse(await client.callTool({ name: "search", arguments: { code: `return await cad.submit({})` } }));
  assert.equal(blocked.ok, false);
});
