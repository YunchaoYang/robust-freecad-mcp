"""Engineering analysis run in the verify phase: mass properties, sketch DoF, parametric flex tests."""

from __future__ import annotations

import re

# Densities in g/cm^3 (typical handbook values).
MATERIALS = {
    "aluminum_6061": 2.70, "steel": 7.85, "stainless_304": 8.00, "brass": 8.50, "copper": 8.96,
    "titanium": 4.43, "abs": 1.04, "pla": 1.24, "petg": 1.27, "nylon": 1.14, "polycarbonate": 1.20, "acetal": 1.41,
}


def _check(name, passed, expected=None, actual=None, message=""):
    return {"name": name, "passed": bool(passed), "expected": expected, "actual": actual, "message": message}


def mass_properties(shape, validation: dict) -> tuple[dict, list[dict]]:
    vol = float(shape.Volume)
    com = None
    try:
        solids = shape.Solids
        if solids:
            tot = sum(s.Volume for s in solids) or 1.0
            cx = sum(s.CenterOfMass.x * s.Volume for s in solids) / tot
            cy = sum(s.CenterOfMass.y * s.Volume for s in solids) / tot
            cz = sum(s.CenterOfMass.z * s.Volume for s in solids) / tot
            com = [round(cx, 4), round(cy, 4), round(cz, 4)]
    except Exception:  # noqa: BLE001
        pass
    out = {"volumeMm3": round(vol, 3), "areaMm2": round(float(shape.Area), 3), "centerOfMassMm": com}
    checks = []
    mat = validation.get("material")
    if mat:
        dens = MATERIALS.get(mat)
        if dens is None:
            checks.append(_check("material.known", False, sorted(MATERIALS), mat, "Unknown material"))
        else:
            mass_g = vol * dens / 1000.0
            out.update(material=mat, densityGcm3=dens, massG=round(mass_g, 3))
            if validation.get("maxMassG") is not None:
                lim = float(validation["maxMassG"])
                checks.append(_check("mass.max", mass_g <= lim, f"<= {lim} g", round(mass_g, 3),
                                     "" if mass_g <= lim else f"Part is {round(mass_g - lim, 2)} g over budget; remove material (pockets, thinner walls)."))
    elif validation.get("maxMassG") is not None:
        checks.append(_check("mass.max", False, "material", None, "maxMassG requires validation.material"))
    return out, checks


def sketch_report(doc) -> list[dict]:
    out = []
    for o in doc.Objects:
        if o.TypeId != "Sketcher::SketchObject":
            continue
        entry = {"name": o.Name, "label": o.Label, "constraints": len(o.Constraints)}
        try:
            o.solve()  # populates DoF / conflict lists (in-memory only)
            entry["dof"] = int(o.DoF)
            entry["fullyConstrained"] = bool(o.FullyConstrained)
            if o.ConflictingConstraints:
                entry["conflicting"] = list(o.ConflictingConstraints)
            if o.RedundantConstraints:
                entry["redundant"] = list(o.RedundantConstraints)
        except Exception as exc:  # noqa: BLE001
            entry["error"] = str(exc)
        out.append(entry)
    return out


def sketch_checks(sketches: list[dict], validation: dict) -> list[dict]:
    if not validation.get("requireFullyConstrained"):
        return []
    if not sketches:
        return [_check("sketch.fullyConstrained", False, ">=1 sketch", 0, "No sketches in the model.")]
    res = []
    for s in sketches:
        ok = s.get("dof") == 0 and not s.get("conflicting") and not s.get("redundant")
        msg = ""
        if not ok:
            msg = f"{s.get('dof')} degree(s) of freedom left" if s.get("dof") else "conflicting/redundant constraints"
            msg += " - add dimensional/positional constraints (e.g. tie a corner to the origin with Coincident(g,1,-1,1))."
        res.append(_check(f"sketch.{s['name']}.fullyConstrained", ok, 0, s.get("dof"), msg))
    return res


_UNIT_RE = re.compile(r"^\s*=?\s*[-+0-9.eE]+\s*([A-Za-z°]+)\s*$")


def _set_alias(doc, alias, value) -> str | None:
    for o in doc.Objects:
        if o.TypeId != "Spreadsheet::Sheet":
            continue
        cell = o.getCellFromAlias(alias)
        if not cell:
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            m = _UNIT_RE.match(o.getContents(cell) or "")
            text = f"{value} {m.group(1)}" if m else str(value)
        else:
            text = str(value)
        o.set(cell, text)
        return f"{o.Name}.{cell}"
    return None


def flex_tests(fcstd_path: str, result_name: str | None, tests: list[dict], tol: float) -> tuple[list[dict], list[dict]]:
    """Re-open the saved model, change spreadsheet parameters, recompute and re-check."""
    import FreeCAD as App

    from validator import describe_shape, detect_holes

    results, checks = [], []
    for i, t in enumerate(tests):
        label = f"flex[{i}]" + (f".{t['name']}" if t.get("name") else "")
        doc = App.openDocument(fcstd_path)
        try:
            missing = []
            for alias, val in (t.get("set") or {}).items():
                if _set_alias(doc, alias, val) is None:
                    missing.append(alias)
            if missing:
                checks.append(_check(f"{label}.aliases", False, list(t["set"]), missing,
                                     f"No spreadsheet alias {missing}; drive dimensions from a Spreadsheet::Sheet with setAlias()."))
                results.append({"name": label, "set": t.get("set"), "ok": False})
                continue
            doc.recompute()
            bad = [o.Label for o in doc.Objects if "Invalid" in (o.State or [])]
            obj = doc.getObject(result_name) if result_name else None
            shape = obj.Shape if obj is not None else None
            geo = describe_shape(shape)
            ok = not bad and not geo["isNull"] and geo["valid"] and geo["solidCount"] >= 1
            checks.append(_check(f"{label}.rebuilds", ok, "valid solid, no failed features",
                                 {"failedFeatures": bad, "valid": geo["valid"], "solids": geo["solidCount"]},
                                 "" if ok else "Model does not rebuild after the parameter change - check expressions and sketch constraints."))
            exp = t.get("expect") or {}
            if ok and exp.get("boundingBoxMm"):
                d = max(abs(a - e) for a, e in zip(geo["boundingBoxMm"], exp["boundingBoxMm"]))
                checks.append(_check(f"{label}.boundingBox", d <= tol, exp["boundingBoxMm"], geo["boundingBoxMm"],
                                     "" if d <= tol else "Dimension did not follow the parameter - bind it with setExpression()."))
            if ok and exp.get("volumeMm3") is not None:
                ev = float(exp["volumeMm3"])
                okv = abs(geo["volumeMm3"] - ev) <= abs(ev) * 0.005
                checks.append(_check(f"{label}.volume", okv, ev, geo["volumeMm3"], ""))
            if ok and exp.get("holeCount") is not None:
                n = len(detect_holes(shape, "z"))
                checks.append(_check(f"{label}.holeCount", n == exp["holeCount"], exp["holeCount"], n, ""))
            results.append({"name": label, "set": t.get("set"), "ok": ok, "boundingBoxMm": geo["boundingBoxMm"], "volumeMm3": geo["volumeMm3"]})
        finally:
            App.closeDocument(doc.Name)
    return results, checks
