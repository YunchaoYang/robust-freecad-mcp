import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../apps/cad-gateway/src/config.js";

export const PYTHON =
  process.env.FREECAD_MCP_PYTHON ?? path.join(os.homedir(), "micromamba", "envs", "freecad-mcp", "bin", "python");
export const HAVE_FREECAD = fs.existsSync(PYTHON);

export function tmpDataDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fcmcp-${tag}-`));
}

export const PLATE_SCRIPT = fs.readFileSync(path.join(REPO_ROOT, "packages", "cad-api", "examples", "partdesign_mounting_plate.py"), "utf8");

export const PLATE_VALIDATION = {
  requireValidShape: true,
  requireSolid: true,
  expectedBoundingBoxMm: [120, 80, 10] as [number, number, number],
  expectedVolumeMm3: 120 * 80 * 10 - 4 * Math.PI * 3.3 * 3.3 * 10,
  requireParametric: true,
  expectedHoleCount: 4,
  holes: [{ diameterMm: 6.6, centersMm: [[12, 12], [108, 12], [12, 68], [108, 68]] as [number, number][] }],
};
