#!/usr/bin/env node
/**
 * freecad-design "<plain-English part request>" [--budget 1] [--iterations 4] [--no-visual]
 * Runs the embedded pi design agent against a local gateway and prints the design record.
 * Model: FREECAD_MCP_DESIGN_MODEL=provider/id, else the first model pi has credentials for.
 */
import { CadGateway } from "../../cad-gateway/src/gateway.js";
import { DesignManager } from "./design-manager.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const budgetUsd = Number(flag("--budget") ?? 1);
const maxIterations = Number(flag("--iterations") ?? 4);
const noVisual = args.includes("--no-visual") ? (args.splice(args.indexOf("--no-visual"), 1), true) : false;
const request = args.join(" ").trim();
if (!request) {
  process.stderr.write('usage: freecad-design "<part request>" [--budget USD] [--iterations N] [--no-visual]\n');
  process.exit(64);
}
process.env.FREECAD_MCP_LOG_STDERR ??= "0";
const gw = new CadGateway();
const designs = new DesignManager(gw);
try {
  const rec = await designs.start(gw.cfg.principal, request, { budgetUsd, maxIterations, visualCheck: !noVisual });
  let shown = 0;
  while (rec.status === "running") {
    await designs.wait(gw.cfg.principal, rec.id, 1000);
    for (; shown < rec.events.length; shown++) process.stderr.write(`[${rec.events[shown].stage}] ${rec.events[shown].message}\n`);
  }
  for (; shown < rec.events.length; shown++) process.stderr.write(`[${rec.events[shown].stage}] ${rec.events[shown].message}\n`);
  process.stdout.write(JSON.stringify({ ...rec, events: undefined }, null, 2) + "\n");
  process.exitCode = rec.status === "succeeded" ? 0 : 1;
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
} finally {
  await designs.close();
  await gw.close();
}
