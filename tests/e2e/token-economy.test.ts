import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT } from "../../apps/cad-gateway/src/config.js";
import { HAVE_FREECAD, PYTHON, tmpDataDir } from "../helpers.js";

const skip = HAVE_FREECAD ? false : `FreeCAD python not found at ${PYTHON}`;
let client: Client;

async function exec(code: string): Promise<any> {
  const r = await client.callTool({ name: "execute", arguments: { code } }, undefined, { timeout: 280_000 });
  return JSON.parse((r.content as { text: string }[])[0].text);
}

before(async () => {
  if (skip) return;
  client = new Client({ name: "e2e-tokens", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "dist", "apps", "mcp-server", "src", "server.js")],
      env: { FREECAD_MCP_PYTHON: PYTHON, FREECAD_MCP_DATA_DIR: tmpDataDir("e2e3"), FREECAD_MCP_LOG_STDERR: "0", PATH: process.env.PATH ?? "" },
      stderr: "ignore",
    }),
  );
});
after(async () => {
  await client?.close();
});

test("zero-script build from a catalog example is validated by default and compact", { skip, timeout: 300_000 }, async () => {
  const out = await exec(`return cad.run({ exampleId: "example.cadkit.mounting_plate" })`);
  assert.equal(out.ok, true, JSON.stringify(out.error));
  const r = out.result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.checks.total >= 8, JSON.stringify(r.checks)); // example's validationExample applied (holes + flex)
  assert.equal(r.failed, undefined);
  assert.deepEqual(r.geometry.bbox, [120, 80, 10]);
  assert.ok(out.stats.approxTokens < 400, `compact result should be small, got ~${out.stats.approxTokens} tokens`);
});

test("repair via fromJob patch, parallel sweep and compare, all without resending the script", { skip, timeout: 300_000 }, async () => {
  const out = await exec(`
    const base = await cad.run({ exampleId: "example.cadkit.mounting_plate", parameters: { length: 140 },
      validation: { expectedBoundingBoxMm: [150, 80, 10] } });              // wrong on purpose
    const fixed = await cad.run({ fromJob: base.id, parameters: { length: 150 } });  // validation merged from base
    const patched = await cad.run({ fromJob: fixed.id, patch: [{ find: "edge=12", replace: "edge=15" }],
      validation: { holes: [{ diameterMm: 6.6, centersMm: [[15, 15], [135, 15], [15, 65], [135, 65]] }] } });
    const sweep = await Promise.all(["aluminum_6061", "steel", "pla"].map(m =>
      cad.run({ fromJob: fixed.id, validation: { material: m } })));
    let badPatch;
    try { await cad.submit({ fromJob: fixed.id, patch: [{ find: "no such text", replace: "x" }] }); } catch (e) { badPatch = e.code; }
    return { base: { ok: base.ok, failed: base.failed.map(f => f.name) }, fixed: fixed.ok, patched: { ok: patched.ok, failed: patched.failed },
      sweep: sweep.map(r => ({ ok: r.ok, massG: r.massG })), cmp: await cad.compare(base.id, fixed.id), badPatch };`);
  assert.equal(out.ok, true, JSON.stringify(out.error));
  const r = out.result;
  assert.equal(r.base.ok, false);
  assert.deepEqual(r.base.failed, ["boundingBox"]);
  assert.equal(r.fixed, true);
  assert.equal(r.patched.ok, true, JSON.stringify(r.patched));
  assert.ok(r.sweep.every((s: any) => s.ok));
  const [al, st, pla] = r.sweep.map((s: any) => s.massG);
  assert.ok(st > al && al > pla, JSON.stringify(r.sweep));
  assert.deepEqual(r.cmp.bboxMm.delta, [10, 0, 0]);
  assert.deepEqual(r.cmp.checksFixed, ["boundingBox"]);
  assert.equal(r.badPatch, "INVALID_REQUEST");
  assert.ok(out.stats.approxTokens < 1200, `~${out.stats.approxTokens} tokens`);
});
