"""FreeCAD worker entrypoint.

    python -I -B worker.py <build|verify> <job_dir>   (job spec JSON on stdin)

build  - sandboxed; runs the untrusted job script, writes out/* and build.json
verify - sandboxed; never runs job code. Re-opens the exported FCStd and STEP
         in a fresh process, computes the authoritative geometry report and
         writes verify.json. The build phase's self-reported numbers are never
         trusted because job code shares that process.

The host passes the job spec on stdin (not via a file the job could rewrite).
"""

from __future__ import annotations

import json
import os
import sys
import time

WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, WORKER_DIR)

from sandbox import apply_rlimits, enter_sandbox  # noqa: E402


def _write_json(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, default=str)
    os.replace(tmp, path)


def _read_only_paths() -> list[str]:
    prefix = os.path.realpath(sys.prefix)
    paths = [
        prefix,
        WORKER_DIR,
        "/usr/lib", "/usr/lib64", "/usr/share/zoneinfo", "/lib", "/lib64",
        "/etc/ld.so.cache", "/etc/localtime", "/etc/fonts",
        "/dev/null", "/dev/zero", "/dev/urandom", "/dev/random",
        "/sys/devices/system/cpu",
        os.path.realpath("/proc/self"),
    ]
    for extra in os.environ.get("FREECAD_MCP_EXTRA_RO", "").split(":"):
        if extra:
            paths.append(extra)
    fc_lib = os.environ.get("FREECAD_LIB")
    if fc_lib:
        paths.append(os.path.realpath(fc_lib))
    return paths


def _freecad_version() -> str:
    import FreeCAD as App

    v = App.Version()
    return ".".join(v[:3]) + (f" ({v[3]})" if len(v) > 3 and v[3] else "")


def phase_build(job_dir: str, spec: dict) -> dict:
    from runner import run_build

    t0 = time.monotonic()
    res = run_build(spec, spec["script"], os.path.join(job_dir, "out"))
    res["durationMs"] = int((time.monotonic() - t0) * 1000)
    return res


def phase_verify(job_dir: str, spec: dict) -> dict:
    import FreeCAD as App
    import Part

    from validator import describe_shape, inspect_document, parametric_checks, validate_shape

    t0 = time.monotonic()
    request = spec["request"]
    validation = request.get("validation") or {}
    out_dir = os.path.join(job_dir, "out")
    res: dict = {"phase": "verify", "ok": False, "checks": [], "artifactChecks": []}

    step_path = os.path.join(out_dir, "model.step")
    fcstd_path = os.path.join(out_dir, "model.FCStd")
    stl_path = os.path.join(out_dir, "model.stl")
    outputs = list(request["outputs"])

    ref_shape = None
    if "STEP" in outputs:
        shape = Part.Shape()
        try:
            shape.read(step_path)
            res["artifactChecks"].append({"format": "STEP", "reimported": not shape.isNull(), "summary": describe_shape(shape)})
            ref_shape = shape
        except Exception as exc:  # noqa: BLE001
            res["artifactChecks"].append({"format": "STEP", "reimported": False, "error": f"{type(exc).__name__}: {exc}"})

    tree = None
    if "FCStd" in outputs:
        try:
            doc = App.openDocument(fcstd_path)
            name = spec.get("resultObject")
            obj = doc.getObject(name) if name else None
            fc_shape = obj.Shape if obj is not None and hasattr(obj, "Shape") else None
            tree = inspect_document(doc, name)
            from analysis import sketch_report

            tree["sketches"] = sketch_report(doc)
            entry = {"format": "FCStd", "reopened": True, "featureTree": tree,
                     "summary": describe_shape(fc_shape) if fc_shape is not None else None}
            if ref_shape is None and fc_shape is not None:
                ref_shape = fc_shape
            elif fc_shape is not None and not fc_shape.isNull() and ref_shape is not None and not ref_shape.isNull():
                dv = abs(fc_shape.Volume - ref_shape.Volume)
                entry["consistentWithStep"] = dv <= max(1e-6 * abs(ref_shape.Volume), 1e-3)
            res["artifactChecks"].append(entry)
            App.closeDocument(doc.Name)
        except Exception as exc:  # noqa: BLE001
            res["artifactChecks"].append({"format": "FCStd", "reopened": False, "error": f"{type(exc).__name__}: {exc}"})

    if "STL" in outputs:
        try:
            import Mesh

            m = Mesh.Mesh(stl_path)
            res["artifactChecks"].append({"format": "STL", "reimported": m.CountFacets > 0, "facets": m.CountFacets,
                                          "watertight": bool(m.isSolid()), "volumeMm3": round(m.Volume, 3)})
        except Exception as exc:  # noqa: BLE001
            res["artifactChecks"].append({"format": "STL", "reimported": False, "error": f"{type(exc).__name__}: {exc}"})

    if ref_shape is None:
        msg = "No exported geometry could be re-imported for validation."
        if not ({"STEP", "FCStd"} & set(outputs)):
            msg += " Include 'STEP' or 'FCStd' in outputs (STL/PNG alone cannot be validated or rendered)."
        res["error"] = {"code": "VALIDATION_FAILED", "message": msg}
        res["durationMs"] = int((time.monotonic() - t0) * 1000)
        return res

    from analysis import flex_tests, mass_properties, sketch_checks

    geometry, checks = validate_shape(ref_shape, validation)
    if tree is not None:
        checks.extend(parametric_checks(tree, validation))
        checks.extend(sketch_checks(tree.get("sketches", []), validation))
        res["featureTree"] = {k: tree[k] for k in ("typeCounts", "sketchConstraints", "expressions", "sketches", "hasParametricFeatures")}
    elif validation.get("requireFullyConstrained") or validation.get("flexTests"):
        checks.append({"name": "fcstd.required", "passed": False, "expected": "FCStd in outputs", "actual": outputs,
                       "message": "requireFullyConstrained/flexTests inspect the FCStd; add 'FCStd' to outputs."})
    res["massProperties"], mass_checks = mass_properties(ref_shape, validation)
    checks.extend(mass_checks)
    if validation.get("flexTests") and tree is not None:
        try:
            res["flexResults"], flex_checks = flex_tests(fcstd_path, spec.get("resultObject"), validation["flexTests"],
                                                         float(validation.get("toleranceMm", 0.01)))
            checks.extend(flex_checks)
        except Exception as exc:  # noqa: BLE001
            checks.append({"name": "flex.run", "passed": False, "expected": True, "actual": False, "message": f"{type(exc).__name__}: {exc}"})
    if "PNG" in outputs:
        try:
            from render import render_preview

            info = render_preview(ref_shape, os.path.join(out_dir, "preview.png"), title=str(spec.get("title") or ""),
                                  views=tuple((request.get("preview") or {}).get("views") or ("iso", "top", "front", "right")))
            res["artifactChecks"].append({"format": "PNG", "reimported": info["nonBlankFraction"] > 0.005, **info})
        except Exception as exc:  # noqa: BLE001
            res["artifactChecks"].append({"format": "PNG", "reimported": False, "error": f"{type(exc).__name__}: {exc}"})
    for ac in res["artifactChecks"]:
        ok = ac.get("reimported", ac.get("reopened", False))
        checks.append({"name": f"artifact.{ac['format']}.readable", "passed": bool(ok), "expected": True, "actual": bool(ok),
                       "message": "" if ok else ac.get("error", "artifact could not be re-imported")})
        if ac.get("consistentWithStep") is False:
            checks.append({"name": "artifact.FCStd.matchesStep", "passed": False, "expected": True, "actual": False,
                           "message": "FCStd result shape volume differs from exported STEP."})
    res["geometry"] = geometry
    if "holes" in validation or validation.get("reportHoles"):
        from validator import detect_holes

        axes = ("x", "y", "z") if validation.get("reportHoles") else ("z",)
        found = []
        for ax in axes:
            found += [{**h, "axis": ax} for h in detect_holes(ref_shape, ax)]
        res["detectedHoles"] = found[:50]
    res["checks"] = checks
    failed = [c for c in checks if not c["passed"]]
    res["ok"] = not failed
    if failed:
        res["error"] = {"code": "VALIDATION_FAILED",
                        "message": f"{len(failed)} check(s) failed: " + "; ".join(f"{c['name']}: {c['message'] or 'failed'}" for c in failed[:6])}
    res["durationMs"] = int((time.monotonic() - t0) * 1000)
    return res


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("build", "verify"):
        print("usage: worker.py <build|verify> <job_dir>", file=sys.stderr)
        return 64
    phase, job_dir = sys.argv[1], os.path.realpath(sys.argv[2])
    spec = json.loads(sys.stdin.read())
    limits = spec.get("limits") or {}
    out_json = os.path.join(job_dir, f"{phase}.json")

    apply_rlimits(
        cpu_seconds=int(limits.get("cpuSeconds", 120)),
        address_space_mb=int(limits.get("addressSpaceMb", 8192)),
        file_size_mb=int(limits.get("fileSizeMb", 256)),
    )
    os.makedirs(os.path.join(job_dir, "out"), exist_ok=True)
    os.chdir(job_dir)

    fc_lib = os.environ.get("FREECAD_LIB") or os.path.join(sys.prefix, "lib")
    sys.path.append(fc_lib)
    try:
        # Import before sandboxing so FreeCAD can initialise its user dirs (HOME
        # points into the job directory) and load its core modules.
        import FreeCAD  # noqa: F401
        import Part  # noqa: F401
        import Sketcher  # noqa: F401
        import PartDesign  # noqa: F401
        import Spreadsheet  # noqa: F401
        import Mesh  # noqa: F401
        import MeshPart  # noqa: F401

        version = _freecad_version()
    except Exception as exc:  # noqa: BLE001
        _write_json(out_json, {"phase": phase, "ok": False, "error": {"code": "WORKER_INIT_FAILED", "message": f"FreeCAD import failed: {exc}"}})
        return 3

    try:
        sandbox_report = enter_sandbox(job_dir, _read_only_paths())
    except OSError as exc:
        _write_json(out_json, {"phase": phase, "ok": False, "error": {"code": "SANDBOX_UNAVAILABLE", "message": str(exc)}})
        return 4

    try:
        res = phase_build(job_dir, spec) if phase == "build" else phase_verify(job_dir, spec)
    except BaseException as exc:  # noqa: BLE001
        res = {"phase": phase, "ok": False, "error": {"code": "WORKER_CRASHED", "message": f"{type(exc).__name__}: {exc}"}}
    res["freecadVersion"] = version
    res["pythonVersion"] = sys.version.split()[0]
    res["sandbox"] = {"enforced": sandbox_report["enforced"],
                      "landlockAbi": (sandbox_report.get("landlock") or {}).get("abi"),
                      "warning": sandbox_report.get("warning")}
    _write_json(out_json, res)
    return 0 if res.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
