"""Build phase: execute the (untrusted) job script and export artifacts.

Script contract
---------------
The script runs with these globals pre-bound:
    App / FreeCAD, Part, Sketcher, params (dict of request parameters), cadkit (helper library)
It MUST leave behind:
    doc         - the FreeCAD document it built (App.newDocument(...))
    result_obj  - the final document object whose .Shape is the part
                  (a PartDesign::Body, a Part feature, ...). A bare Part.Shape
                  is accepted and wrapped in a Part::Feature named "Result".
The runner recomputes ``doc``, reports features in error, and exports.
"""

from __future__ import annotations

import traceback

SCRIPT_FILENAME = "<job_script>"
MAX_TB_CHARS = 4000


def _script_traceback(exc: BaseException) -> str:
    """Keep only frames from the job script (plus the exception line)."""
    tb = traceback.extract_tb(exc.__traceback__)
    frames = [f for f in tb if f.filename == SCRIPT_FILENAME] or tb[-3:]
    lines = ["Traceback (job script frames):"]
    for f in frames:
        lines.append(f'  line {f.lineno}, in {f.name}' + (f": {f.line}" if f.line else ""))
    lines.extend(traceback.format_exception_only(type(exc), exc))
    text = "\n".join(l.rstrip("\n") for l in lines)
    return text[-MAX_TB_CHARS:]


def _feature_errors(doc) -> list[dict]:
    errs = []
    for o in doc.Objects:
        state = list(getattr(o, "State", []) or [])
        invalid = "Invalid" in state or "Error" in state
        try:
            invalid = invalid or (hasattr(o, "isValid") and not o.isValid())
        except Exception:  # noqa: BLE001
            pass
        if invalid:
            msg = ""
            try:
                msg = o.getStatusString()
            except Exception:  # noqa: BLE001
                pass
            errs.append({"name": o.Name, "label": o.Label, "type": o.TypeId, "state": state, "message": msg})
    return errs[:20]


def run_build(spec: dict, script: str, out_dir: str) -> dict:
    import FreeCAD as App
    import Part
    import Sketcher

    import builtins

    import cadkit
    from exporter import export_all

    request = spec["request"]
    result: dict = {"phase": "build", "ok": False}

    g = {
        "__name__": "__job__",
        "__builtins__": __builtins__,
        "App": App,
        "FreeCAD": App,
        "Part": Part,
        "Sketcher": Sketcher,
        "params": dict(request.get("parameters") or {}),
        "cadkit": cadkit,
    }
    builtins.__cadkit_params__ = dict(request.get("parameters") or {})
    try:
        code = compile(script, SCRIPT_FILENAME, "exec")
    except SyntaxError as exc:
        result["error"] = {"code": "SCRIPT_SYNTAX_ERROR", "message": f"{exc.msg} (line {exc.lineno}, col {exc.offset})",
                           "traceback": "".join(traceback.format_exception_only(type(exc), exc))[-MAX_TB_CHARS:]}
        return result

    # Make source lines available for tracebacks.
    import linecache

    linecache.cache[SCRIPT_FILENAME] = (len(script), None, script.splitlines(True), SCRIPT_FILENAME)
    try:
        exec(code, g)  # noqa: S102 - this is the sandboxed job
    except SystemExit as exc:
        result["error"] = {"code": "SCRIPT_ERROR", "message": f"script called exit({exc.code})"}
        return result
    except BaseException as exc:  # noqa: BLE001
        result["error"] = {"code": "SCRIPT_ERROR", "message": f"{type(exc).__name__}: {exc}", "traceback": _script_traceback(exc)}
        return result

    doc = g.get("doc") or App.ActiveDocument
    result_obj = g.get("result_obj")
    if doc is None:
        result["error"] = {"code": "SCRIPT_CONTRACT", "message": "Script must define `doc` (e.g. doc = App.newDocument('Part'))."}
        return result
    if result_obj is None:
        result["error"] = {"code": "SCRIPT_CONTRACT", "message": "Script must define `result_obj`: the final document object whose .Shape is the part."}
        return result
    if isinstance(result_obj, Part.Shape):
        feat = doc.addObject("Part::Feature", "Result")
        feat.Shape = result_obj
        result_obj = feat
        result["wrappedShape"] = True
    if not hasattr(result_obj, "Shape") or not hasattr(result_obj, "Document") or result_obj.Document is not doc:
        result["error"] = {"code": "SCRIPT_CONTRACT", "message": "`result_obj` must be an object in `doc` with a .Shape property."}
        return result

    try:
        doc.recompute()
    except Exception as exc:  # noqa: BLE001
        result["error"] = {"code": "RECOMPUTE_ERROR", "message": f"{type(exc).__name__}: {exc}"}
        return result

    result["featureErrors"] = _feature_errors(doc)
    result["resultObject"] = result_obj.Name
    shape = result_obj.Shape
    if shape.isNull():
        msg = "result_obj.Shape is null after recompute."
        if result["featureErrors"]:
            fe = result["featureErrors"][0]
            msg += f" First failing feature: {fe['label']} ({fe['type']}): {fe['message'] or fe['state']}"
        result["error"] = {"code": "RECOMPUTE_ERROR", "message": msg, "featureErrors": result["featureErrors"]}
        return result

    exports = export_all(doc, result_obj, list(request["outputs"]), out_dir)
    result["exports"] = exports
    failed = [e for e in exports if not e["ok"]]
    if failed:
        result["error"] = {"code": "EXPORT_FAILED", "message": "; ".join(f"{e['format']}: {e.get('error')}" for e in failed)}
        return result
    result["ok"] = True
    return result
