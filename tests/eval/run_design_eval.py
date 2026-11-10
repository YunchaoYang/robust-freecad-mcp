"""NL->CAD benchmark for the embedded pi `design` agent (server-side agent, any model).

    python3 tests/eval/run_design_eval.py --base-url http://localhost:8000/v1 --model Qwen3.8-27B \
        [--tasks washer l_bracket] [--workers 2] [--out docs/data/eval_design_qwen.json]

Same tasks and the same hidden-spec grader as run_eval.py (which drives Claude Code as an MCP
client). Here the agent is the server's own `design` pipeline (spec -> locked build -> visual
review), launched through the freecad-design CLI. Each task gets its own data dir so parallel
workers never share a job store. Besides pass/fail, we report how often the agent's own verdict
("succeeded") agrees with the hidden grader: a self-reported success that fails the hidden spec
is a false positive.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from run_eval import find_step, grade  # noqa: E402

PYTHON = os.environ.get("FREECAD_MCP_PYTHON", str(Path.home() / "micromamba/envs/freecad-mcp/bin/python"))
NODE = str(Path(PYTHON).parent / "node")


def run_task(task: dict, a: argparse.Namespace, out_dir: Path, tol: dict) -> dict:
    data_dir = out_dir / task["id"] / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    env = {
        "PATH": f"{Path(NODE).parent}:/usr/bin:/bin",
        "HOME": os.environ.get("HOME", "/tmp"),
        "FREECAD_MCP_PYTHON": PYTHON,
        "FREECAD_MCP_DATA_DIR": str(data_dir),
        "FREECAD_MCP_LOG_STDERR": "0",
        "FREECAD_MCP_DESIGN_BASE_URL": a.base_url,
        "FREECAD_MCP_DESIGN_MODEL": a.model,
        "FREECAD_MCP_DESIGN_THINKING": a.thinking,
    }
    cmd = [NODE, str(ROOT / "dist/apps/design-agent/src/cli.js"), task["prompt"],
           "--iterations", str(a.iterations), "--budget", "5", "--tool-mode", a.tool_mode]
    t0 = time.monotonic()
    print(f"[{task['id']}] start", file=sys.stderr, flush=True)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=a.timeout, env=env, cwd=str(ROOT))
        stdout, stderr = p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        stdout, stderr = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""), "TIMEOUT"
    wall = round(time.monotonic() - t0, 1)
    (out_dir / task["id"] / "events.log").write_text(stderr)
    try:
        rec = json.loads(stdout)
    except json.JSONDecodeError:
        rec = {"status": "crashed", "error": {"message": (stderr or stdout)[-500:]}}
    step = find_step(data_dir, rec["jobId"]) if rec.get("jobId") else None
    try:
        g = grade(step, task["hidden"], tol) if step else {"pass": False, "checks": {"artifact": False}}
    except Exception as exc:  # noqa: BLE001 - keep the rest of the run
        g = {"pass": False, "checks": {"graderError": False}, "error": f"{type(exc).__name__}: {exc}"}
    res = rec.get("result") or {}
    r = {
        "id": task["id"],
        "agentStatus": rec.get("status"),
        "pass": g["pass"],
        "grade": g,
        "iterations": rec.get("iterations"),
        "toolMode": rec.get("toolMode"),
        "modelCalls": rec.get("modelCalls"),
        "stageMs": rec.get("stageMs"),
        "wallSec": wall,
        "tokens": rec.get("tokens"),
        "lockedChecks": res.get("checks"),
        "failedLocked": [f.get("name") for f in res.get("failed") or []],
        "visualReview": rec.get("visualReview"),
        "validationSpec": rec.get("validationSpec"),
        "jobId": rec.get("jobId"),
        "error": rec.get("error"),
        "events": [l for l in stderr.splitlines() if l.startswith("[")][-12:],
    }
    print(f"[{task['id']}] agent={r['agentStatus']} hidden={'PASS' if g['pass'] else 'FAIL'} "
          f"iter={r['iterations']} wall={wall}s checks={g['checks']}", file=sys.stderr, flush=True)
    return r


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8000/v1")
    ap.add_argument("--model", default="Qwen3.8-27B")
    ap.add_argument("--thinking", default="low")
    ap.add_argument("--tool-mode", default="codemode", choices=["codemode", "classic"])
    ap.add_argument("--iterations", type=int, default=4)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--tasks", nargs="*")
    ap.add_argument("--work", default=str(ROOT / "data" / "eval-design"))
    ap.add_argument("--out", default=str(ROOT / "docs" / "data" / "eval_design_qwen.json"))
    a = ap.parse_args()

    spec = json.loads((HERE / "tasks.json").read_text())
    tasks = [t for t in spec["tasks"] if not a.tasks or t["id"] in a.tasks]
    out_dir = Path(a.work) / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        results = list(ex.map(lambda t: run_task(t, a, out_dir, spec["tolerances"]), tasks))

    n = len(results)
    succeeded = [r for r in results if r["agentStatus"] == "succeeded"]
    summary = {
        "agent": "embedded pi design agent (spec -> locked build -> visual review)",
        "model": a.model,
        "endpoint": a.base_url,
        "thinking": a.thinking,
        "toolMode": a.tool_mode,
        "tasks": n,
        "passedHidden": sum(r["pass"] for r in results),
        "agentReportedSuccess": len(succeeded),
        "falsePositives": sum(1 for r in succeeded if not r["pass"]),
        "falseNegatives": sum(1 for r in results if r["pass"] and r["agentStatus"] != "succeeded"),
        "medianIterations": statistics.median([r["iterations"] or 0 for r in results]) if n else None,
        "medianWallSec": statistics.median([r["wallSec"] for r in results]) if n else None,
        "medianModelCalls": statistics.median([sum((r.get("modelCalls") or {}).values()) for r in results]) if n else None,
        "medianBuildMs": statistics.median([(r.get("stageMs") or {}).get("build", 0) for r in results]) if n else None,
        "totalWallSec": round(time.monotonic() - t0, 1),
        "workers": a.workers,
        "totalTokens": {k: sum((r["tokens"] or {}).get(k, 0) for r in results) for k in ("input", "output")},
        "costUsd": 0,
        "date": time.strftime("%Y-%m-%d"),
        "runsPerTask": 1,
        "workDir": str(out_dir.relative_to(ROOT)) if out_dir.is_relative_to(ROOT) else str(out_dir),
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps({"summary": summary, "results": results}, indent=1))
    print(json.dumps(summary, indent=1), flush=True)


if __name__ == "__main__":
    main()
