import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GatewayConfig } from "./config.js";

export interface PhaseOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Parsed <phase>.json written by the worker, or null if missing/corrupt. */
  report: Record<string, unknown> | null;
}

/**
 * Runs one worker phase as a fresh OS process:
 *  - empty environment except an explicit allowlist (no host secrets),
 *  - HOME/TMPDIR/XDG dirs inside the job work dir,
 *  - its own process group so a timeout or cancel kills everything,
 *  - stdout/stderr captured to host-owned log files outside the sandbox root,
 *  - the job spec is piped on stdin, never read from a sandbox-writable file.
 */
export async function runWorkerPhase(
  cfg: GatewayConfig,
  phase: "build" | "verify",
  jobDir: string,
  spec: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PhaseOutcome> {
  const workDir = path.join(jobDir, "work");
  const logsDir = path.join(jobDir, "logs");
  for (const d of ["home", "tmp", "out"]) fs.mkdirSync(path.join(workDir, d), { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const reportPath = path.join(workDir, `${phase}.json`);
  fs.rmSync(reportPath, { force: true });

  const stdoutFd = fs.openSync(path.join(logsDir, `${phase}.stdout.log`), "w");
  const stderrFd = fs.openSync(path.join(logsDir, `${phase}.stderr.log`), "w");
  const home = path.join(workDir, "home");
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    TMPDIR: path.join(workDir, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LANG: "C.UTF-8",
    QT_QPA_PLATFORM: "offscreen",
    FREECAD_LIB: cfg.freecadLib,
    OMP_NUM_THREADS: "2",
  };
  if (cfg.allowUnsandboxed) env.FREECAD_MCP_ALLOW_UNSANDBOXED = "1";

  const started = Date.now();
  const child = spawn(cfg.pythonPath, ["-I", "-B", cfg.workerScript, phase, workDir], {
    cwd: workDir,
    env,
    detached: true, // new process group
    stdio: ["pipe", stdoutFd, stderrFd],
  });
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  let timedOut = false;
  let cancelled = false;
  const killGroup = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  const onAbort = () => {
    cancelled = true;
    killGroup();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  child.stdin?.on("error", () => undefined);
  child.stdin?.end(JSON.stringify(spec));

  const { code, sig } = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
    child.on("error", () => resolve({ code: 127, sig: null }));
    child.on("exit", (c, s) => resolve({ code: c, sig: s }));
  });
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  killGroup(); // reap any stragglers in the group

  let report: Record<string, unknown> | null = null;
  try {
    const st = fs.lstatSync(reportPath);
    if (st.isFile() && st.size < 8 * 1024 * 1024) {
      const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed as Record<string, unknown>;
    }
  } catch {
    report = null;
  }
  return { exitCode: code, signal: sig, timedOut, cancelled, durationMs: Date.now() - started, report };
}

/** Read at most `maxBytes` from the end of a host-owned log file. */
export function tailLog(file: string, maxBytes: number): string {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return "";
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return (st.size > len ? "…[truncated]…\n" : "") + buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
