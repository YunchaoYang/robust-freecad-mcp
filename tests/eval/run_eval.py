"""NL->CAD benchmark: an agent (Claude Code, headless) uses this MCP server; a hidden spec grades the result.

    python3 tests/eval/run_eval.py [--tasks mounting_plate washer] [--model sonnet] [--out docs/data/eval_results.json]

Per task:
  1. `claude -p` runs with ONLY this server's MCP tools allowed (no shell/file tools), and is
     asked to end its answer with `FINAL_JOB_ID: <id>`.
  2. The grader copies that job's exported model.step into a fresh work dir and runs the
     sandboxed verify phase (reportHoles on all axes). The agent's own validation spec is
     ignored: grading uses `hidden` from tasks.json (orientation-free bbox, volume, holes).
  3. Turns, wall time, tokens and cost come from claude's JSON output.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "cad"))
from harness import run_phase  # noqa: E402

TOOLS = ["search", "execute", "job_status", "artifacts"]
SUFFIX = ("\n\nUse only the FreeCAD MCP tools. Make sure the job completes and its artifacts are published. "
          "End your final answer with a line `FINAL_JOB_ID: <job id>` for the job that produced the final part.")


def run_agent(prompt: str, model: str | None, max_turns: int, server: str, timeout: int) -> dict:
    allowed = ",".join(f"mcp__{server}__{t}" for t in TOOLS)
    cmd = ["claude", "-p", prompt + SUFFIX, "--mcp-config", str(ROOT / ".mcp.json"), "--strict-mcp-config",
           "--allowedTools", allowed, "--output-format", "json", "--max-turns", str(max_turns)]
    if model:
        cmd += ["--model", model]
    t0 = time.monotonic()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=tempfile.mkdtemp(prefix="eval-cwd-"))
    wall = time.monotonic() - t0
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"error": f"claude exit {p.returncode}: {p.stderr[-500:] or p.stdout[-500:]}", "wallSec": wall}
    usage = out.get("usage") or {}
    text = out.get("result") or ""
    m = re.findall(r"FINAL_JOB_ID:\s*`?([A-Za-z0-9_-]{6,})`?", text)
    return {"jobId": m[-1] if m else None, "turns": out.get("num_turns"), "wallSec": round(wall, 1),
            "costUsd": out.get("total_cost_usd"), "isError": out.get("is_error"),
            "tokens": {"input": usage.get("input_tokens"), "output": usage.get("output_tokens"),
                       "cacheRead": usage.get("cache_read_input_tokens"), "cacheWrite": usage.get("cache_creation_input_tokens")},
            "finalText": text[-600:]}


def find_step(data_dir: Path, job_id: str) -> Path | None:
    for p in (data_dir / "jobs" / job_id).rglob("*.step"):
        if "artifacts" in p.parts:
            return p
    return None


def grade(step: Path, hidden: dict, tol: dict) -> dict:
    work = Path(tempfile.mkdtemp(prefix="eval-grade-"))
    (work / "out").mkdir()
    shutil.copy(step, work / "out" / "model.step")
    spec = {"script": "", "request": {"outputs": ["STEP"], "validation": {"reportHoles": True, "requireValidShape": True,
                                                                          "requireSolid": True}},
            "limits": {"cpuSeconds": 120, "addressSpaceMb": 4096, "fileSizeMb": 256}}
    _, v, _ = run_phase("verify", str(work), spec)
    checks = {}
    geo = v.get("geometry") or {}
    checks["validSolid"] = bool(geo.get("valid")) and geo.get("solidCount", 0) == 1
    bb = sorted(geo.get("boundingBoxMm") or [0, 0, 0])
    if "bboxSorted" in hidden:
        checks["bbox"] = all(abs(a - e) <= tol["lengthMm"] for a, e in zip(bb, sorted(hidden["bboxSorted"])))
    if "bboxSortedApprox" in hidden:  # e.g. hexagon: across flats or across corners depending on orientation
        checks["bbox"] = all(any(abs(a - e) <= tol["lengthMm"] for e in opts) for a, opts in zip(bb, hidden["bboxSortedApprox"]))
    if "volumeMm3" in hidden:
        vol = geo.get("volumeMm3", 0)
        checks["volume"] = abs(vol - hidden["volumeMm3"]) <= hidden["volumeMm3"] * tol["volumePct"] / 100
    holes = Counter(f"{round(h['diameterMm'] / 0.1) * 0.1:.1f}" for h in v.get("detectedHoles", []))
    if "holes" in hidden:
        want = Counter({f"{float(k):.1f}": n for k, n in hidden["holes"].items()})
        checks["holes"] = holes == want
    if "holeOffsetsFromEdges" in hidden:
        spec_h = hidden["holeOffsetsFromEdges"]
        ok = True
        for h in v.get("detectedHoles", []):
            if abs(h["diameterMm"] - spec_h["diameter"]) > tol["diameterMm"]:
                continue
            idx = {"x": (1, 2), "y": (0, 2), "z": (0, 1)}[h["axis"]]
            ext = geo["boundingBoxMm"]
            c = h["centerFromBBoxMinMm"]
            for i in idx:
                d = min(c[i], ext[i] - c[i])
                ok &= abs(d - spec_h["offset"]) <= tol["lengthMm"]
        checks["holePositions"] = ok
    return {"pass": all(checks.values()), "checks": checks,
            "measured": {"bboxSorted": bb, "volumeMm3": geo.get("volumeMm3"), "holes": dict(holes)}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", nargs="*")
    ap.add_argument("--model")
    ap.add_argument("--max-turns", type=int, default=25)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--server", default=None, help="MCP server name in .mcp.json")
    ap.add_argument("--out", default=str(ROOT / "docs" / "data" / "eval_results.json"))
    a = ap.parse_args()
    mcp_cfg = json.loads((ROOT / ".mcp.json").read_text())["mcpServers"]
    server = a.server or next(iter(mcp_cfg))
    data_dir = Path(mcp_cfg[server].get("env", {}).get("FREECAD_MCP_DATA_DIR", ROOT / "data"))
    spec = json.loads((Path(__file__).parent / "tasks.json").read_text())
    results = []
    for t in spec["tasks"]:
        if a.tasks and t["id"] not in a.tasks:
            continue
        print(f"[{t['id']}] running agent...", file=sys.stderr, flush=True)
        r = {"id": t["id"], **run_agent(t["prompt"], a.model, a.max_turns, server, a.timeout)}
        step = find_step(data_dir, r["jobId"]) if r.get("jobId") else None
        r["grade"] = grade(step, t["hidden"], spec["tolerances"]) if step else {"pass": False, "checks": {"artifact": False}}
        print(f"[{t['id']}] pass={r['grade']['pass']} turns={r.get('turns')} wall={r.get('wallSec')}s "
              f"checks={r['grade']['checks']}", file=sys.stderr, flush=True)
        results.append(r)
    n = len(results)
    summary = {"tasks": n, "passed": sum(r["grade"]["pass"] for r in results),
               "medianTurns": sorted(r.get("turns") or 0 for r in results)[n // 2] if n else None,
               "totalCostUsd": round(sum(r.get("costUsd") or 0 for r in results), 4),
               "model": a.model or "default", "date": time.strftime("%Y-%m-%d")}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps({"summary": summary, "results": results}, indent=1))
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
