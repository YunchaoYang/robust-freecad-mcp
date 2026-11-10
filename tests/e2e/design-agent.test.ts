import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createServer } from "../../apps/mcp-server/src/server.js";
import type { DesignModel } from "../../apps/design-agent/src/design-agent.js";
import { HAVE_FREECAD, PYTHON, tmpDataDir } from "../helpers.js";

const skip = HAVE_FREECAD ? false : `FreeCAD python not found at ${PYTHON}`;
const faux = registerFauxProvider({ models: [{ id: "faux-cad", input: ["text", "image"] }] });
let designModel: DesignModel;
let client: Client;
let close: () => Promise<void>;
let designsRef: import("../../apps/design-agent/src/design-manager.js").DesignManager | undefined;
const seen = { reviewerGotImage: false, builderGotImage: false };

type Ctx = { messages: { role: string; content: unknown }[] };
const lastText = (ctx: Ctx) => JSON.stringify(ctx.messages.at(-1)?.content ?? "");
const lastJobId = (ctx: Ctx) => /job_[A-Za-z0-9_-]{22}/.exec(lastText(ctx))?.[0];
const hasImage = (ctx: Ctx) => JSON.stringify(ctx.messages.at(-1)?.content ?? "").includes('"type":"image"');

const SPEC = {
  validation: {
    expectedBoundingBoxMm: [120, 80, 10],
    holes: [{ diameterMm: 6.6, centersMm: [[12, 12], [108, 12], [12, 68], [108, 68]] }],
    expectedHoleCount: 4,
    requireFullyConstrained: true,
    material: "aluminum_6061",
  },
  notes: "X=length 120, Y=width 80, Z=thickness 10. M6 clearance 6.6 mm (ISO 273 medium), centres 12 mm from edges.",
};

function script(): Parameters<typeof faux.setResponses>[0] {
  return [
    // 1. spec session
    fauxAssistantMessage("```json\n" + JSON.stringify(SPEC) + "\n```"),
    // 2. builder: search
    fauxAssistantMessage([fauxText("Looking for an example."), fauxToolCall("cad_search", { query: "mounting plate holes" })], { stopReason: "toolUse" }),
    // 3. builder: wrong length AND an attempt to weaken the acceptance test
    fauxAssistantMessage(
      [fauxToolCall("cad_execute", { code: `return cad.run({ exampleId: "example.cadkit.mounting_plate", parameters: { length: 110 }, validation: { expectedBoundingBoxMm: [110, 80, 10], holes: [] } })` })],
      { stopReason: "toolUse" },
    ),
    // 4. builder: repair from the failed job, look at the render
    (ctx: Ctx) => {
      const id = lastJobId(ctx);
      assert.match(lastText(ctx), /boundingBox/, "locked spec must have failed the weakened attempt");
      return fauxAssistantMessage(
        [fauxToolCall("cad_execute", { code: `const r = await cad.run({ fromJob: "${id}", parameters: { length: 120 } }); return { r, img: r.ok && await cad.preview(r.id) };` })],
        { stopReason: "toolUse" },
      );
    },
    // 5. builder: done
    (ctx: Ctx) => {
      seen.builderGotImage = hasImage(ctx);
      return fauxAssistantMessage(`DONE ${lastJobId(ctx)}`);
    },
    // 6. reviewer
    (ctx: Ctx) => {
      seen.reviewerGotImage = hasImage(ctx);
      return fauxAssistantMessage('```json\n{"matches": true, "issues": []}\n```');
    },
  ] as never;
}

before(async () => {
  if (skip) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faux-rt-"));
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const m = faux.getModel();
  modelRuntime.registerProvider(m.provider, {
    api: m.api,
    baseUrl: "http://faux.invalid",
    apiKey: "test",
    models: [{ id: m.id, name: "faux", input: ["text", "image"], reasoning: false, contextWindow: 200_000, maxTokens: 8000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 } }],
  } as never);
  designModel = { modelRuntime, model: modelRuntime.getModel(m.provider, m.id)! };
  const created = createServer({ dataDir: tmpDataDir("design"), pythonPath: PYTHON }, { enableDesign: true, designModel });
  designsRef = created.designs;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await created.server.connect(a);
  client = new Client({ name: "design-test", version: "0" });
  await client.connect(b);
  close = async () => {
    await client.close();
    await created.designs?.close();
    await created.gateway.close();
  };
});
after(async () => {
  await close?.();
  faux.unregister();
});

test("design tool: spec locked, weakened attempt fails, fromJob repair passes, render reviewed", { skip, timeout: 300_000 }, async () => {
  faux.setResponses(script());
  const res = await client.callTool(
    { name: "design", arguments: { request: "120 x 80 x 10 mm aluminium mounting plate, four M6 clearance holes 12 mm from the edges", waitMs: 240_000, includeEvents: true } },
    undefined,
    { timeout: 280_000 },
  );
  const content = res.content as { type: string; text?: string; mimeType?: string }[];
  const rec = JSON.parse(content[0].text!);
  assert.equal(rec.status, "succeeded", JSON.stringify({ error: rec.error, events: rec.events }, null, 1));
  assert.deepEqual(rec.validationSpec.expectedBoundingBoxMm, [120, 80, 10]);
  assert.equal(rec.iterations, 2);
  assert.equal(rec.result.ok, true);
  assert.deepEqual(rec.result.geometry.bbox, [120, 80, 10]);
  assert.ok(rec.result.massG > 200 && rec.result.massG < 300, String(rec.result.massG));
  assert.deepEqual(rec.visualReview, [{ matches: true, issues: [] }], JSON.stringify({ events: rec.events, result: rec.result, pending: faux.getPendingResponseCount() }));
  assert.ok(seen.builderGotImage, "builder should see the render");
  assert.ok(seen.reviewerGotImage, "reviewer should receive the render");
  assert.equal(content.filter((c) => c.type === "image").length, 1, "client receives the final render");
  assert.ok(rec.events.some((e: { message: string }) => e.message.startsWith("locked spec")));
  assert.ok(rec.tokens.output > 0);
  assert.equal(faux.getPendingResponseCount(), 0);
});

test("design tool: iteration budget is enforced and failures are structured", { skip, timeout: 300_000 }, async () => {
  const bad = { code: `return cad.run({ exampleId: "example.cadkit.mounting_plate", parameters: { length: 100 } })` };
  faux.setResponses([
    fauxAssistantMessage("```json\n" + JSON.stringify(SPEC) + "\n```"),
    fauxAssistantMessage([fauxToolCall("cad_execute", bad)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("cad_execute", bad)], { stopReason: "toolUse" }), // over budget -> refused
    (ctx: Ctx) => {
      assert.match(lastText(ctx), /Iteration budget/);
      return fauxAssistantMessage("FAILED could not satisfy the spec");
    },
  ] as never);
  const start = JSON.parse(((await client.callTool({ name: "design", arguments: { request: "same plate", maxIterations: 1, visualCheck: false } })).content as { text: string }[])[0].text);
  assert.equal(start.status, "running");
  const res = await client.callTool({ name: "design", arguments: { designId: start.id, waitMs: 240_000 } }, undefined, { timeout: 280_000 });
  const rec = JSON.parse((res.content as { text: string }[])[0].text);
  assert.equal(rec.status, "failed");
  assert.equal(rec.iterations, 1);
  assert.equal(rec.error.code, "VALIDATION_FAILED");
  assert.equal(rec.result.ok, false);
  assert.ok(rec.result.failed.some((f: { name: string }) => f.name === "boundingBox"));
  assert.equal(res.isError, true);
});

test("design tool: unknown / foreign ids are NOT_FOUND", { skip }, async () => {
  const r = JSON.parse(((await client.callTool({ name: "design", arguments: { designId: "dsn_AAAAAAAAAAAAAAAA" } })).content as { text: string }[])[0].text);
  assert.equal(r.error.code, "NOT_FOUND");
});

test("design tool: visual mismatch is fed back to the builder and re-reviewed", { skip, timeout: 300_000 }, async () => {
  let feedback = "";
  faux.setResponses([
    fauxAssistantMessage("```json\n" + JSON.stringify({ validation: { expectedBoundingBoxMm: [120, 80, 10] }, notes: "plate" }) + "\n```"),
    fauxAssistantMessage([fauxToolCall("cad_execute", { code: `return cad.run({ exampleId: "example.cadkit.mounting_plate", parameters: { corner: 3 } })` })], { stopReason: "toolUse" }),
    (ctx: Ctx) => fauxAssistantMessage(`DONE ${lastJobId(ctx)}`),
    fauxAssistantMessage('```json\n{"matches": false, "issues": ["corners must be sharp, not rounded"]}\n```'),
    (ctx: Ctx) => {
      feedback = lastText(ctx);
      const id = /job_[A-Za-z0-9_-]{22}/.exec(feedback)![0];
      return fauxAssistantMessage([fauxToolCall("cad_execute", { code: `return cad.run({ fromJob: "${id}", parameters: { corner: 0.01 } })` })], { stopReason: "toolUse" });
    },
    (ctx: Ctx) => fauxAssistantMessage(`DONE ${lastJobId(ctx)}`),
    fauxAssistantMessage('```json\n{"matches": true, "issues": []}\n```'),
  ] as never);
  const res = await client.callTool({ name: "design", arguments: { request: "120x80x10 plate with sharp corners", waitMs: 240_000 } }, undefined, { timeout: 280_000 });
  const rec = JSON.parse((res.content as { text: string }[])[0].text);
  assert.equal(rec.status, "succeeded", JSON.stringify({ error: rec.error, events: rec.events }));
  assert.match(feedback, /corners must be sharp/);
  assert.equal(rec.visualReview.length, 2);
  assert.equal(rec.visualReview[0].matches, false);
  assert.equal(rec.visualReview[1].matches, true);
  assert.equal(rec.iterations, 2);
  assert.equal(faux.getPendingResponseCount(), 0);
});

test("design agent, classic tool mode (ablation baseline): full scripts, full results, same locked spec", { skip, timeout: 300_000 }, async () => {
  const box = (len: number) =>
    `doc = App.newDocument("B")\nresult_obj = doc.addObject("Part::Box", "Box")\nresult_obj.Length = ${len}\nresult_obj.Width = 20\nresult_obj.Height = 10`;
  let sawFullResult = false;
  faux.setResponses([
    fauxAssistantMessage("```json\n" + JSON.stringify({ validation: { expectedBoundingBoxMm: [20, 20, 10] }, notes: "block" }) + "\n```"),
    fauxAssistantMessage([fauxToolCall("cad_submit", { script: box(30), outputs: ["STEP"] })], { stopReason: "toolUse" }),
    (ctx: Ctx) => fauxAssistantMessage([fauxToolCall("cad_status", { id: lastJobId(ctx)! })], { stopReason: "toolUse" }),
    (ctx: Ctx) => {
      sawFullResult = /\\?"checks\\?":\[/.test(lastText(ctx)) && /boundingBox/.test(lastText(ctx));
      return fauxAssistantMessage([fauxToolCall("cad_submit", { script: box(20) })], { stopReason: "toolUse" });
    },
    (ctx: Ctx) => fauxAssistantMessage([fauxToolCall("cad_status", { id: lastJobId(ctx)! })], { stopReason: "toolUse" }),
    (ctx: Ctx) => fauxAssistantMessage(`DONE ${lastJobId(ctx)}`),
    fauxAssistantMessage('```json\n{"matches": true, "issues": []}\n```'),
  ] as never);
  const rec = await designsRef!.start("local", "20 x 20 x 10 mm block", { toolMode: "classic" });
  await designsRef!.wait("local", rec.id, 240_000);
  assert.equal(rec.status, "succeeded", JSON.stringify({ error: rec.error, events: rec.events }));
  assert.equal(rec.toolMode, "classic");
  assert.equal(rec.iterations, 2);
  assert.ok(sawFullResult, "classic cad_status returns the full result with every check");
  assert.ok((rec.modelCalls?.build ?? 0) >= 5, JSON.stringify(rec.modelCalls));
  assert.ok((rec.stageMs?.build ?? 0) > 0);
  assert.deepEqual(rec.result?.geometry?.bbox, [20, 20, 10]);
  assert.equal(faux.getPendingResponseCount(), 0);
});
