import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT } from "../../apps/cad-gateway/src/config.js";
import { HAVE_FREECAD, PLATE_SCRIPT, PLATE_VALIDATION, PYTHON, tmpDataDir } from "../helpers.js";

const skip = HAVE_FREECAD ? false : `FreeCAD python not found at ${PYTHON}`;
let client: Client;
const dataDir = tmpDataDir("e2e");

function parse(r: unknown): any {
  return JSON.parse((r as { content: { text: string }[] }).content[0].text);
}

before(async () => {
  if (skip) return;
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "dist", "apps", "mcp-server", "src", "server.js")],
      env: { FREECAD_MCP_PYTHON: PYTHON, FREECAD_MCP_DATA_DIR: dataDir, FREECAD_MCP_LOG_STDERR: "0", PATH: process.env.PATH ?? "" },
      stderr: "ignore",
    }),
  );
});
after(async () => {
  await client?.close();
});

test("mounting plate: one execute submits, waits, validates and lists artifacts", { skip, timeout: 240_000 }, async () => {
  const code = `
    const job = await cad.submit({
      script: ${JSON.stringify(PLATE_SCRIPT)},
      scriptLanguage: "freecad-python",
      outputs: ["FCStd", "STEP", "STL"],
      validation: ${JSON.stringify(PLATE_VALIDATION)},
    });
    const r = await cad.wait(job.id);
    const arts = r.status === "completed" ? await cad.artifacts(job.id) : [];
    return { id: job.id, status: r.status, error: r.error, geometry: r.geometry,
             failed: (r.checks || []).filter(c => !c.passed), nChecks: (r.checks || []).length,
             featureTree: r.featureTree, sandbox: r.sandbox, arts };`;
  const out = parse(await client.callTool({ name: "execute", arguments: { code } }, undefined, { timeout: 200_000 }));
  assert.equal(out.ok, true, JSON.stringify(out.error));
  const r = out.result;
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.deepEqual(r.failed, []);
  assert.ok(r.nChecks >= 10);
  assert.deepEqual(r.geometry.boundingBoxMm, [120, 80, 10]);
  assert.equal(r.geometry.solidCount, 1);
  assert.equal(r.sandbox.enforced, true);
  assert.ok(r.featureTree.sketchConstraints > 0 && r.featureTree.expressions > 0);
  assert.deepEqual(r.arts.map((a: any) => a.format).sort(), ["FCStd", "STEP", "STL"]);

  // Artifact retrieval by id (metadata + inline content) and via resources/read
  const step = r.arts.find((a: any) => a.format === "STEP");
  const meta = await client.callTool({ name: "artifacts", arguments: { jobId: r.id, artifactId: step.artifactId, includeContent: true } });
  const blob = (meta.content as any[])[1].resource.blob as string;
  const bytes = Buffer.from(blob, "base64");
  assert.equal(bytes.length, step.sizeBytes);
  assert.match(bytes.subarray(0, 64).toString(), /ISO-10303-21/);
  const res = await client.readResource({ uri: step.resourceUri });
  assert.equal((res.contents[0] as any).blob, blob);

  // Independent STEP import + FCStd parametric edit in a separate FreeCAD process (outside the server).
  const fcstd = r.arts.find((a: any) => a.format === "FCStd");
  const fcMeta = parse(await client.callTool({ name: "artifacts", arguments: { jobId: r.id, artifactId: fcstd.artifactId } }));
  const stepMeta = parse(await client.callTool({ name: "artifacts", arguments: { jobId: r.id, artifactId: step.artifactId } }));
  const check = `
import sys, json
sys.path.append(sys.argv[3])
import FreeCAD as App, Part, Import
d = App.newDocument("imp"); Import.insert(sys.argv[2], d.Name)
vol = sum(o.Shape.Volume for o in d.Objects if hasattr(o, "Shape"))
doc = App.openDocument(sys.argv[1])
doc.getObject("Params").set("length", "150 mm"); doc.recompute()
bb = doc.getObject("Body").Shape.BoundBox
print(json.dumps({"stepVolume": vol, "editedBox": [bb.XLength, bb.YLength, bb.ZLength], "valid": doc.getObject("Body").Shape.isValid()}))`;
  const script = path.join(dataDir, "check.py");
  fs.writeFileSync(script, check);
  const lib = path.join(path.dirname(path.dirname(PYTHON)), "lib");
  const stdout = execFileSync(PYTHON, [script, fileURLToPath(fcMeta.fileUri), fileURLToPath(stepMeta.fileUri), lib], {
    env: { QT_QPA_PLATFORM: "offscreen", HOME: dataDir, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  const last = JSON.parse(stdout.trim().split("\n").at(-1)!);
  assert.ok(Math.abs(last.stepVolume - PLATE_VALIDATION.expectedVolumeMm3) < 1, String(last.stepVolume));
  assert.deepEqual(last.editedBox.map((x: number) => Math.round(x * 1000) / 1000), [150, 80, 10]);
  assert.equal(last.valid, true);
});

test("bounded repair loop: wrong dimensions fail with actionable checks, fixed script passes", { skip, timeout: 240_000 }, async () => {
  const bad = PLATE_SCRIPT;
  const code = `
    const attempt = async (parameters) => {
      const j = await cad.submit({ script: ${JSON.stringify(bad)}, scriptLanguage: "freecad-python", outputs: ["STEP"],
        parameters, validation: { expectedBoundingBoxMm: [120, 80, 10], holes: [{ diameterMm: 6.6, centersMm: [[12,12]] }] } });
      return cad.wait(j.id);
    };
    const first = await attempt({ length: 100 });
    const failed = first.checks.filter(c => !c.passed).map(c => ({ name: c.name, expected: c.expected, actual: c.actual }));
    const second = await attempt({});
    return { first: { status: first.status, code: first.error && first.error.code, failed, artifacts: first.artifacts }, second: second.status };`;
  const out = parse(await client.callTool({ name: "execute", arguments: { code } }, undefined, { timeout: 200_000 }));
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.result.first.status, "failed");
  assert.equal(out.result.first.code, "VALIDATION_FAILED");
  assert.ok(out.result.first.failed.some((c: any) => c.name === "boundingBox" && c.actual[0] === 100));
  assert.equal(out.result.first.artifacts, undefined);
  assert.equal(out.result.second, "completed");
});

test("script errors, contract violations and timeouts are structured", { skip, timeout: 240_000 }, async () => {
  const code = `
    const sub = (script, extra = {}) => cad.submit({ script, scriptLanguage: "freecad-python", outputs: ["STEP"], ...extra });
    const jobs = await Promise.all([
      sub("doc = App.newDocument('a')\\nresult_obj = doc.addObject('Part::Box','B')\\nraise ValueError('nope')"),
      sub("x = 1"),
      sub("def f(:\\n  pass"),
      sub("import time\\nwhile True: pass", { timeoutSec: 5 }),
      sub("import socket\\nsocket.create_connection(('1.1.1.1', 80))"),
    ]);
    const rs = await Promise.all(jobs.map(j => cad.wait(j.id)));
    return rs.map(r => ({ status: r.status, code: r.error && r.error.code, msg: r.error && r.error.message, tb: !!(r.error && r.error.traceback) }));`;
  const out = parse(await client.callTool({ name: "execute", arguments: { code } }, undefined, { timeout: 200_000 }));
  assert.equal(out.ok, true, JSON.stringify(out.error));
  const [scriptErr, contract, syntax, timeout, net] = out.result;
  assert.equal(scriptErr.code, "SCRIPT_ERROR");
  assert.ok(scriptErr.tb);
  assert.match(scriptErr.msg, /ValueError: nope/);
  assert.equal(contract.code, "SCRIPT_CONTRACT");
  assert.equal(syntax.code, "SCRIPT_SYNTAX_ERROR");
  assert.equal(timeout.code, "TIMEOUT");
  assert.equal(net.code, "SCRIPT_ERROR");
  assert.match(net.msg, /PermissionError/);
});

test("cancellation of a running job", { skip, timeout: 120_000 }, async () => {
  const code = `
    const j = await cad.submit({ script: "import time\\nwhile True: time.sleep(0.1)", scriptLanguage: "freecad-python", outputs: ["STEP"], timeoutSec: 60 });
    let s; do { s = await cad.status(j.id); } while (s.status === "queued");
    await cad.cancel(j.id);
    return await cad.wait(j.id, { timeoutMs: 10000 });`;
  const out = parse(await client.callTool({ name: "execute", arguments: { code } }));
  assert.equal(out.result.status, "cancelled", JSON.stringify(out));
});
