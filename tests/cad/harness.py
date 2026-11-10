"""Helpers to run the FreeCAD worker exactly as the gateway does (scrubbed env, spec on stdin)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKER = os.path.join(ROOT, "apps", "cad-worker", "worker.py")
EXAMPLES = os.path.join(ROOT, "packages", "cad-api", "examples")
PYTHON = os.environ.get("FREECAD_MCP_PYTHON") or os.path.expanduser("~/micromamba/envs/freecad-mcp/bin/python")
LIMITS = {"cpuSeconds": 120, "addressSpaceMb": 4096, "fileSizeMb": 256}


def example(name: str) -> str:
    with open(os.path.join(EXAMPLES, name), encoding="utf-8") as f:
        return f.read()


def _env(work: str) -> dict:
    home = os.path.join(work, "home")
    os.makedirs(home, exist_ok=True)
    os.makedirs(os.path.join(work, "tmp"), exist_ok=True)
    return {
        "PATH": "/usr/bin:/bin", "HOME": home, "XDG_CONFIG_HOME": os.path.join(home, ".config"),
        "XDG_DATA_HOME": os.path.join(home, ".local", "share"), "XDG_CACHE_HOME": os.path.join(home, ".cache"),
        "TMPDIR": os.path.join(work, "tmp"), "LANG": "C.UTF-8", "QT_QPA_PLATFORM": "offscreen",
        "FREECAD_LIB": os.path.join(os.path.dirname(os.path.dirname(PYTHON)), "lib"),
    }


def run_phase(phase: str, work: str, spec: dict, timeout: int = 180) -> tuple[int, dict, str]:
    p = subprocess.run([PYTHON, "-I", "-B", WORKER, phase, work], input=json.dumps(spec), capture_output=True,
                       text=True, env=_env(work), cwd=work, timeout=timeout)
    path = os.path.join(work, f"{phase}.json")
    data = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    return p.returncode, data, p.stdout + p.stderr


def run_job(script: str, outputs=("FCStd", "STEP"), validation: dict | None = None, parameters: dict | None = None,
            work: str | None = None) -> dict:
    """Run build then (if ok) verify. Returns {'build':..., 'verify':..., 'work':...}."""
    work = work or tempfile.mkdtemp(prefix="fcjob-")
    request = {"outputs": list(outputs), "validation": validation or {}, "parameters": parameters or {}}
    spec = {"script": script, "request": request, "limits": LIMITS}
    code_b, build, log_b = run_phase("build", work, spec)
    res = {"work": work, "build": build, "buildExit": code_b, "buildLog": log_b}
    if build.get("ok"):
        code_v, verify, log_v = run_phase("verify", work, {**spec, "script": "", "resultObject": build.get("resultObject")})
        res.update(verify=verify, verifyExit=code_v, verifyLog=log_v)
    return res


if __name__ == "__main__":  # quick manual run: python harness.py <example.py>
    r = run_job(example(sys.argv[1]), outputs=("FCStd", "STEP", "STL"), validation={"reportHoles": True})
    print(json.dumps({k: r[k] for k in ("build", "verify") if k in r}, indent=1)[:6000])
