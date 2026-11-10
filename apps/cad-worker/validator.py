"""Geometry validation for exported CAD shapes.

Every check yields a structured record ``{name, passed, expected, actual, message}``
so an agent can repair its script from the failure alone.
"""

from __future__ import annotations

import math
from typing import Any

DEFAULT_TOL_MM = 0.01


def _r(x: float, nd: int = 4) -> float:
    return round(float(x), nd)


def _check(name: str, passed: bool, expected: Any = None, actual: Any = None, message: str = "") -> dict:
    return {"name": name, "passed": bool(passed), "expected": expected, "actual": actual, "message": message}


def describe_shape(shape) -> dict:
    """Compact, JSON-safe geometric summary of a Part.Shape."""
    if shape is None or shape.isNull():
        return {"isNull": True, "valid": False, "solidCount": 0, "volumeMm3": 0.0, "boundingBoxMm": [0, 0, 0]}
    bb = shape.BoundBox
    return {
        "isNull": False,
        "valid": bool(shape.isValid()),
        "shapeType": shape.ShapeType,
        "solidCount": len(shape.Solids),
        "shellCount": len(shape.Shells),
        "faceCount": len(shape.Faces),
        "edgeCount": len(shape.Edges),
        "volumeMm3": _r(shape.Volume, 3),
        "areaMm2": _r(shape.Area, 3),
        "boundingBoxMm": [_r(bb.XLength), _r(bb.YLength), _r(bb.ZLength)],
        "boundingBoxMinMm": [_r(bb.XMin), _r(bb.YMin), _r(bb.ZMin)],
        "boundingBoxMaxMm": [_r(bb.XMax), _r(bb.YMax), _r(bb.ZMax)],
    }


def _cylinder_groups(shape, axis_dir) -> list[dict]:
    """Group cylindrical faces by (radius, axis line) — a full hole is often split by a seam."""
    import FreeCAD as App

    want = App.Vector(*axis_dir).normalize()
    groups: list[dict] = []
    for face in shape.Faces:
        surf = face.Surface
        if surf.__class__.__name__ != "Cylinder":
            continue
        ax = App.Vector(surf.Axis).normalize()
        if abs(abs(ax.dot(want)) - 1.0) > 1e-6:
            continue
        c = surf.Center
        # Project the axis point onto the plane normal to the axis (for Z: x,y).
        key_pt = c - want * c.dot(want)
        # Concavity: on a hole the outward face normal points toward the axis.
        u0, u1, v0, v1 = face.ParameterRange
        uv = ((u0 + u1) / 2, (v0 + v1) / 2)
        pnt = face.valueAt(*uv)
        radial = pnt - (c + ax * (pnt - c).dot(ax))
        concave = face.normalAt(*uv).dot(radial) < 0
        bb = face.BoundBox
        lo = min(bb.XMin * want.x + bb.YMin * want.y + bb.ZMin * want.z, bb.XMax * want.x + bb.YMax * want.y + bb.ZMax * want.z)
        hi = max(bb.XMin * want.x + bb.YMin * want.y + bb.ZMin * want.z, bb.XMax * want.x + bb.YMax * want.y + bb.ZMax * want.z)
        for g in groups:
            if abs(g["radius"] - surf.Radius) < 1e-6 and (g["point"] - key_pt).Length < 1e-6:
                g["lo"], g["hi"] = min(g["lo"], lo), max(g["hi"], hi)
                g["faces"] += 1
                g["concave"] = g["concave"] and concave
                g["sweep"] += abs(u1 - u0)
                break
        else:
            groups.append({"radius": surf.Radius, "point": key_pt, "lo": lo, "hi": hi, "faces": 1, "concave": concave, "sweep": abs(u1 - u0)})
    return groups


def detect_holes(shape, axis: str = "z") -> list[dict]:
    """Return cylindrical *holes* (material outside the cylinder, not bosses) along an axis."""
    import FreeCAD as App

    axis_dir = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}[axis]
    want = App.Vector(*axis_dir)
    bb = shape.BoundBox
    out = []
    for g in _cylinder_groups(shape, axis_dir):
        if not g["concave"]:  # outer cylindrical wall / boss / pin, not a hole
            continue
        if g["sweep"] < 2 * math.pi - 1e-3:  # partial cylinder: slot end, fillet, notch — not a round hole
            continue
        mid = (g["lo"] + g["hi"]) / 2.0
        center = g["point"] + want * mid
        p = [_r(center.x), _r(center.y), _r(center.z)]
        out.append({
            "diameterMm": _r(2 * g["radius"]),
            "centerMm": p,
            "centerFromBBoxMinMm": [_r(center.x - bb.XMin), _r(center.y - bb.YMin), _r(center.z - bb.ZMin)],
            "depthMm": _r(g["hi"] - g["lo"]),
        })
    out.sort(key=lambda h: (h["centerMm"][0], h["centerMm"][1], h["centerMm"][2]))
    return out


def validate_shape(shape, validation: dict) -> tuple[dict, list[dict]]:
    """Run requested validations. Returns (geometry summary, checks)."""
    tol = float(validation.get("toleranceMm", DEFAULT_TOL_MM))
    geo = describe_shape(shape)
    checks: list[dict] = []

    checks.append(_check("shape.notNull", not geo["isNull"], True, not geo["isNull"],
                         "" if not geo["isNull"] else "Result shape is null — did the final feature compute?"))
    if geo["isNull"]:
        return geo, checks

    if validation.get("requireValidShape", True):
        checks.append(_check("shape.isValid", geo["valid"], True, geo["valid"],
                             "" if geo["valid"] else "Shape.isValid() is False — typical causes: self-intersections, failed booleans, tangent coplanar faces. Try shape.fix() or simplify booleans."))
    if validation.get("requireSolid", True):
        ok = geo["solidCount"] >= 1
        checks.append(_check("shape.hasSolid", ok, ">=1", geo["solidCount"],
                             "" if ok else "No solid found. Extrude closed wires / pad closed sketches; open wires produce faces or shells only."))
    if "expectedSolidCount" in validation:
        exp = int(validation["expectedSolidCount"])
        checks.append(_check("shape.solidCount", geo["solidCount"] == exp, exp, geo["solidCount"],
                             "" if geo["solidCount"] == exp else "Unexpected solid count — fuse touching bodies or remove stray solids."))

    exp_bb = validation.get("expectedBoundingBoxMm")
    if exp_bb:
        act = geo["boundingBoxMm"]
        diffs = [abs(a - e) for a, e in zip(act, exp_bb)]
        ok = all(d <= tol for d in diffs)
        # Accept axis-permuted matches only as a hint, never as a pass.
        msg = ""
        if not ok:
            msg = f"Bounding box {act} differs from expected {list(exp_bb)} (tolerance {tol} mm)."
            if sorted(round(a, 3) for a in act) == sorted(round(float(e), 3) for e in exp_bb):
                msg += " Dimensions match but on different axes — check sketch plane / extrusion direction."
        checks.append(_check("boundingBox", ok, list(exp_bb), act, msg))

    exp_vol = validation.get("expectedVolumeMm3")
    if exp_vol is not None:
        pct = float(validation.get("volumeTolerancePct", 0.5))
        act_v = geo["volumeMm3"]
        ok = abs(act_v - exp_vol) <= abs(exp_vol) * pct / 100.0
        checks.append(_check("volume", ok, exp_vol, act_v,
                             "" if ok else f"Volume off by {_r(act_v - exp_vol, 3)} mm^3 (tolerance {pct}%)."))

    holes_spec = validation.get("holes") or []
    if holes_spec:
        found_by_axis: dict[str, list[dict]] = {}
        for spec in holes_spec:
            axis = spec.get("axis", "z")
            if axis not in found_by_axis:
                found_by_axis[axis] = detect_holes(shape, axis)
            found = found_by_axis[axis]
            dia = float(spec["diameterMm"])
            ref = spec.get("reference", "bboxMin")
            through = spec.get("through", True)
            span = {"x": geo["boundingBoxMm"][0], "y": geo["boundingBoxMm"][1], "z": geo["boundingBoxMm"][2]}[axis]
            plane_idx = {"x": (1, 2), "y": (0, 2), "z": (0, 1)}[axis]
            for i, c in enumerate(spec["centersMm"]):
                best = None
                for h in found:
                    pt = h["centerFromBBoxMinMm"] if ref == "bboxMin" else h["centerMm"]
                    d = math.hypot(pt[plane_idx[0]] - c[0], pt[plane_idx[1]] - c[1])
                    if best is None or d < best[0]:
                        best = (d, h)
                name = f"hole[{i}]@{list(c)}"
                if best is None:
                    checks.append(_check(name, False, {"diameterMm": dia, "center": list(c)}, None,
                                         f"No cylindrical hole along {axis} found."))
                    continue
                d, h = best
                problems = []
                if d > tol:
                    problems.append(f"nearest hole is {_r(d)} mm away")
                if abs(h["diameterMm"] - dia) > tol:
                    problems.append(f"diameter {h['diameterMm']} != {dia}")
                if through and h["depthMm"] + tol < span:
                    problems.append(f"not through (depth {h['depthMm']} < {span})")
                actual = {"diameterMm": h["diameterMm"],
                          "center": [h[("centerFromBBoxMinMm" if ref == "bboxMin" else "centerMm")][k] for k in plane_idx],
                          "depthMm": h["depthMm"]}
                checks.append(_check(name, not problems, {"diameterMm": dia, "center": list(c), "through": through}, actual,
                                     "; ".join(problems) + (f" (reference: {ref})" if problems else "")))
        if "expectedHoleCount" in validation:
            n = sum(len(v) for v in found_by_axis.values())
            exp_n = int(validation["expectedHoleCount"])
            checks.append(_check("holeCount", n == exp_n, exp_n, n, "" if n == exp_n else "Unexpected number of holes."))

    return geo, checks


def inspect_document(doc, result_name: str | None) -> dict:
    """Summarise the feature tree for parametric-editability checks."""
    objs = []
    sketch_constraints = 0
    expressions = 0
    type_counts: dict[str, int] = {}
    for o in doc.Objects:
        tid = o.TypeId
        type_counts[tid] = type_counts.get(tid, 0) + 1
        exprs = len(getattr(o, "ExpressionEngine", []) or [])
        expressions += exprs
        entry = {"name": o.Name, "label": o.Label, "type": tid}
        if tid == "Sketcher::SketchObject":
            n = len(o.Constraints)
            sketch_constraints += n
            entry["constraints"] = n
        if exprs:
            entry["expressions"] = exprs
        objs.append(entry)
    parametric_types = {"PartDesign::Body", "Sketcher::SketchObject", "Spreadsheet::Sheet"}
    has_features = any(t.startswith("PartDesign::") and t != "PartDesign::Body" for t in type_counts) or any(
        t in ("Part::Extrusion", "Part::Cut", "Part::Fuse", "Part::Box", "Part::Cylinder") for t in type_counts)
    return {
        "objectCount": len(objs),
        "objects": objs[:60],
        "truncated": len(objs) > 60,
        "typeCounts": type_counts,
        "sketchConstraints": sketch_constraints,
        "expressions": expressions,
        "hasParametricFeatures": bool(has_features and (parametric_types & set(type_counts) or expressions)),
        "resultObject": result_name,
    }


def parametric_checks(tree: dict, validation: dict) -> list[dict]:
    checks = []
    if validation.get("requireParametric"):
        ok = tree["hasParametricFeatures"] and tree["sketchConstraints"] + tree["expressions"] > 0
        checks.append(_check("parametric.featureTree", ok, "PartDesign/Part features driven by constraints or expressions",
                             {"sketchConstraints": tree["sketchConstraints"], "expressions": tree["expressions"],
                              "types": sorted(tree["typeCounts"])},
                             "" if ok else "FCStd contains no editable parametric features. Build with PartDesign Body + constrained Sketches (or Part primitives/booleans) instead of baking a Part::Feature shape."))
    return checks
