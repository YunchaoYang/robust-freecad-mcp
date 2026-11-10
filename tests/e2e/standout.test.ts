import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT } from "../../apps/cad-gateway/src/config.js";
import { HAVE_FREECAD, PLATE_SCRIPT, PLATE_VALIDATION, PYTHON, tmpDataDir } from "../helpers.js";

const skip = HAVE_FREECAD ? false : `FreeCAD python not found at ${PYTHON}`;
let client: Client;

before(async () => {
  if (skip) return;
  client = new Client({ name: "e2e-standout", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "dist", "apps", "mcp-server", "src", "server.js")],
      env: { FREECAD_MCP_PYTHON: PYTHON, FREECAD_MCP_DATA_DIR: tmpDataDir("e2e2"), FREECAD_MCP_LOG_STDERR: "0", PATH: process.env.PATH ?? "" },
      stderr: "ignore",
    }),
  );
});
after(async () => {
  await client?.close();
});

test("plate with render, mass, fully-constrained sketches and flex tests; agent receives the image", { skip, timeout: 300_000 }, async () => {
  const validation = {
    ...PLATE_VALIDATION,
    material: "aluminum_6061",
    maxMassG: 400,
    requireFullyConstrained: true,
    flexTests: [
      { name: "longer", set: { length: 150 }, expect: { boundingBoxMm: [150, 80, 10], holeCount: 4 } },
      { name: "bigger holes", set: { holeDiameter: 9 }, expect: { holeCount: 4 } },
    ],
  };
  const code = `
    const job = await cad.submit({ script: ${JSON.stringify(PLATE_SCRIPT)}, scriptLanguage: "freecad-python",
      outputs: ["FCStd", "STEP", "PNG"], validation: ${JSON.stringify(validation)} });
    const r = await cad.wait(job.id);
    return { status: r.status, error: r.error, failed: (r.checks || []).filter(c => !c.passed),
      names: (r.checks || []).map(c => c.name), mass: r.massProperties, sketches: r.featureTree && r.featureTree.sketches,
      preview: r.preview, formats: (r.artifacts || []).map(a => a.format).sort(),
      image: r.status === "completed" ? await cad.preview(job.id) : null };`;
  const res = await client.callTool({ name: "execute", arguments: { code } }, undefined, { timeout: 280_000 });
  const content = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
  const out = JSON.parse(content[0].text!);
  assert.equal(out.ok, true, JSON.stringify(out.error));
  const r = out.result;
  assert.equal(r.status, "completed", JSON.stringify({ error: r.error, failed: r.failed }));
  assert.deepEqual(r.formats, ["FCStd", "PNG", "STEP"]);
  // mass: 94631.5 mm^3 * 2.70 g/cm^3 ≈ 255.5 g
  assert.ok(Math.abs(r.mass.massG - 255.5) < 2, JSON.stringify(r.mass));
  assert.ok(r.names.includes("mass.max"));
  assert.ok(r.names.some((n: string) => n.startsWith("flex[0]")));
  assert.ok(r.names.some((n: string) => n.startsWith("flex[1]")));
  assert.ok(r.sketches.length >= 2 && r.sketches.every((s: any) => s.fullyConstrained === true), JSON.stringify(r.sketches));
  assert.equal(r.preview.rendered, true);
  assert.match(r.image.preview, /attached/);
  const imgs = content.filter((c) => c.type === "image");
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].mimeType, "image/png");
  assert.equal(Buffer.from(imgs[0].data!, "base64").subarray(1, 4).toString(), "PNG");
});

test("flex test that breaks the model is reported, and maxMassG is enforced", { skip, timeout: 300_000 }, async () => {
  const code = `
    const job = await cad.submit({ script: ${JSON.stringify(PLATE_SCRIPT)}, scriptLanguage: "freecad-python", outputs: ["FCStd", "STEP"],
      validation: { material: "steel", maxMassG: 100,
        flexTests: [{ name: "zero thickness", set: { thickness: 0 } }] } });
    const r = await cad.wait(job.id);
    return { status: r.status, code: r.error && r.error.code, failed: r.checks.filter(c => !c.passed).map(c => c.name), artifacts: r.artifacts };`;
  const out = JSON.parse((await client.callTool({ name: "execute", arguments: { code } }, undefined, { timeout: 280_000 }) as any).content[0].text);
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.code, "VALIDATION_FAILED");
  assert.ok(out.result.failed.includes("mass.max"), JSON.stringify(out.result.failed));
  assert.ok(out.result.failed.some((n: string) => n.startsWith("flex[0]")), JSON.stringify(out.result.failed));
  assert.equal(out.result.artifacts, undefined);
});
