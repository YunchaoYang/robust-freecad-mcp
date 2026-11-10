import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (works from both src/ and dist/). */
export const REPO_ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src: <root>/apps/cad-gateway/src ; dist: <root>/dist/apps/cad-gateway/src
  const up3 = path.resolve(here, "../../..");
  return path.basename(up3) === "dist" ? path.dirname(up3) : up3;
})();

export interface GatewayConfig {
  dataDir: string;
  pythonPath: string;
  freecadLib: string;
  workerScript: string;
  catalogPath: string;
  examplesDir: string;
  principal: string;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  maxActiveJobsPerPrincipal: number;
  submissionsPerMinute: number;
  defaultJobTimeoutSec: number;
  maxJobTimeoutSec: number;
  addressSpaceMb: number;
  fileSizeMb: number;
  retentionHours: number;
  keepWorkDirs: boolean;
  allowUnsandboxed: boolean;
  maxInlineArtifactBytes: number;
}

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const pythonPath = overrides.pythonPath ?? process.env.FREECAD_MCP_PYTHON ?? "python3";
  const envPrefix = path.dirname(path.dirname(pythonPath));
  const cfg: GatewayConfig = {
    dataDir: path.resolve(process.env.FREECAD_MCP_DATA_DIR ?? path.join(REPO_ROOT, "data")),
    pythonPath,
    freecadLib: process.env.FREECAD_MCP_FREECAD_LIB ?? path.join(envPrefix, "lib"),
    workerScript: path.join(REPO_ROOT, "apps", "cad-worker", "worker.py"),
    catalogPath: path.join(REPO_ROOT, "packages", "cad-api", "catalog.json"),
    examplesDir: path.join(REPO_ROOT, "packages", "cad-api", "examples"),
    principal: process.env.FREECAD_MCP_PRINCIPAL ?? "local",
    maxConcurrentJobs: int("FREECAD_MCP_MAX_CONCURRENT", 2, 1, 64),
    maxQueuedJobs: int("FREECAD_MCP_MAX_QUEUED", 32, 1, 10000),
    maxActiveJobsPerPrincipal: int("FREECAD_MCP_MAX_ACTIVE_PER_USER", 8, 1, 1000),
    submissionsPerMinute: int("FREECAD_MCP_SUBMISSIONS_PER_MIN", 30, 1, 10000),
    defaultJobTimeoutSec: int("FREECAD_MCP_JOB_TIMEOUT_SEC", 120, 5, 600),
    maxJobTimeoutSec: int("FREECAD_MCP_MAX_JOB_TIMEOUT_SEC", 600, 5, 3600),
    addressSpaceMb: int("FREECAD_MCP_ADDRESS_SPACE_MB", 4096, 512, 1 << 20),
    fileSizeMb: int("FREECAD_MCP_FILE_SIZE_MB", 256, 1, 1 << 16),
    retentionHours: int("FREECAD_MCP_RETENTION_HOURS", 72, 1, 24 * 365),
    keepWorkDirs: process.env.FREECAD_MCP_KEEP_WORKDIRS === "1",
    allowUnsandboxed: process.env.FREECAD_MCP_ALLOW_UNSANDBOXED === "1",
    maxInlineArtifactBytes: int("FREECAD_MCP_MAX_INLINE_ARTIFACT_BYTES", 4 * 1024 * 1024, 0, 64 * 1024 * 1024),
  };
  return { ...cfg, ...overrides };
}
