"""cadkit — a small, tested helper layer for agent-written FreeCAD scripts.

Goal: let an agent express a *fully constrained, spreadsheet-driven* PartDesign
model in ~15 lines instead of ~80, with fewer ways to get it wrong.

    m = cadkit.Model("Plate", length=120, width=80, thickness=10, hole=cadkit.clearance("M6"), edge=12)
    s = m.sketch("Outline")                       # on XY
    s.rect(0, 0, "length", "width")              # numbers or parameter expressions
    m.pad(s, "thickness")
    h = m.sketch("Holes")
    for x, y in [("edge", "edge"), ("length - edge", "edge"), ("edge", "width - edge"), ("length - edge", "width - edge")]:
        h.circle(x, y, "hole")
    m.pocket(h)                                  # through all, both directions
    doc, result_obj = m.finish()

Values: a number is a constant (mm); a string is an expression over parameter
names ("length - edge", "hole / 2"). Expressions become FreeCAD expressions
bound to the `Params` spreadsheet, so the saved FCStd stays editable.
"""

from __future__ import annotations

import math
import re

import FreeCAD as App
import Part
import Sketcher

__all__ = ["Model", "Sketch", "clearance", "tap_drill", "counterbore", "edges", "faces", "rect_pattern", "polar_points"]

# ----------------------------------------------------------------------------- standards (ISO metric)

_CLEARANCE = {  # ISO 273: fine / medium / coarse
    "M2": (2.2, 2.4, 2.6), "M2.5": (2.7, 2.9, 3.1), "M3": (3.2, 3.4, 3.6), "M4": (4.3, 4.5, 4.8),
    "M5": (5.3, 5.5, 5.8), "M6": (6.4, 6.6, 7.0), "M8": (8.4, 9.0, 10.0), "M10": (10.5, 11.0, 12.0),
    "M12": (13.0, 13.5, 14.5), "M16": (17.0, 17.5, 18.5), "M20": (21.0, 22.0, 24.0), "M24": (25.0, 26.0, 28.0),
}
_TAP = {"M2": 1.6, "M2.5": 2.05, "M3": 2.5, "M4": 3.3, "M5": 4.2, "M6": 5.0, "M8": 6.8, "M10": 8.5, "M12": 10.2,
        "M16": 14.0, "M20": 17.5, "M24": 21.0}
_CBORE = {  # socket head cap screw (ISO 4762), typical counterbore diameter / depth
    "M3": (6.5, 3.4), "M4": (8.0, 4.4), "M5": (10.0, 5.4), "M6": (11.0, 6.4), "M8": (15.0, 8.6),
    "M10": (18.0, 10.6), "M12": (20.0, 12.6), "M16": (26.0, 16.6), "M20": (33.0, 20.6),
}


def _size(s: str) -> str:
    s = s.strip().upper()
    return s if s.startswith("M") else "M" + s


def clearance(size: str, fit: str = "medium") -> float:
    """ISO 273 clearance-hole diameter, e.g. clearance('M6') -> 6.6."""
    return _CLEARANCE[_size(size)][{"fine": 0, "medium": 1, "coarse": 2}[fit]]


def tap_drill(size: str) -> float:
    """Tap drill diameter for coarse-pitch metric threads, e.g. tap_drill('M6') -> 5.0."""
    return _TAP[_size(size)]


def counterbore(size: str) -> tuple[float, float]:
    """(diameter, depth) of a typical counterbore for an ISO 4762 socket head cap screw."""
    return _CBORE[_size(size)]


def rect_pattern(x0, y0, dx, dy, nx, ny) -> list[tuple[float, float]]:
    return [(x0 + i * dx, y0 + j * dy) for j in range(ny) for i in range(nx)]


def polar_points(radius, count, start_deg=0.0, cx=0.0, cy=0.0) -> list[tuple[float, float]]:
    return [(cx + radius * math.cos(math.radians(start_deg + 360.0 * k / count)),
             cy + radius * math.sin(math.radians(start_deg + 360.0 * k / count))) for k in range(count)]


# ----------------------------------------------------------------------------- selectors

def _axis_vec(axis):
    return {"X": App.Vector(1, 0, 0), "Y": App.Vector(0, 1, 0), "Z": App.Vector(0, 0, 1)}[axis.upper()]


def edges(feature_or_shape, kind: str | None = None, parallel: str | None = None, at: dict | None = None,
          radius: float | None = None, tol: float = 1e-4) -> list[str]:
    """Edge names ('EdgeN') chosen by geometry — robust against topological renumbering.

    kind: 'line' | 'circle' | None;  parallel: 'X'|'Y'|'Z' (lines: direction, circles: axis);
    at: {'x': v, 'z': v, ...} — the edge lies entirely at those coordinates;  radius: circle radius.
    """
    shape = getattr(feature_or_shape, "Shape", feature_or_shape)
    out = []
    for i, e in enumerate(shape.Edges):
        cname = e.Curve.__class__.__name__
        if kind == "line" and cname not in ("Line", "LineSegment"):
            continue
        if kind == "circle" and cname != "Circle":
            continue
        if parallel:
            v = _axis_vec(parallel)
            if cname == "Circle":
                if abs(abs(e.Curve.Axis.normalize().dot(v)) - 1) > tol:
                    continue
            else:
                d = e.Vertexes[-1].Point - e.Vertexes[0].Point if len(e.Vertexes) > 1 else None
                if d is None or d.Length < tol or abs(abs(d.normalize().dot(v)) - 1) > tol:
                    continue
        if radius is not None and (cname != "Circle" or abs(e.Curve.Radius - radius) > tol):
            continue
        if at:
            bb = e.BoundBox
            ok = True
            for k, val in at.items():
                lo, hi = {"x": (bb.XMin, bb.XMax), "y": (bb.YMin, bb.YMax), "z": (bb.ZMin, bb.ZMax)}[k.lower()]
                if abs(lo - val) > tol or abs(hi - val) > tol:
                    ok = False
            if not ok:
                continue
        out.append(f"Edge{i + 1}")
    return out


def faces(feature_or_shape, normal: str | None = None, at: dict | None = None, tol: float = 1e-4) -> list[str]:
    """Planar face names by normal direction ('+Z', '-X', ...) and/or position."""
    shape = getattr(feature_or_shape, "Shape", feature_or_shape)
    out = []
    for i, f in enumerate(shape.Faces):
        if normal:
            if f.Surface.__class__.__name__ != "Plane":
                continue
            sign = -1 if normal.startswith("-") else 1
            want = _axis_vec(normal.lstrip("+-")) * sign
            u0, u1, v0, v1 = f.ParameterRange
            if (f.normalAt((u0 + u1) / 2, (v0 + v1) / 2) - want).Length > 1e-3:
                continue
        if at:
            bb = f.BoundBox
            if any(abs(lo - val) > tol or abs(hi - val) > tol for k, val in at.items()
                   for lo, hi in [{"x": (bb.XMin, bb.XMax), "y": (bb.YMin, bb.YMax), "z": (bb.ZMin, bb.ZMax)}[k.lower()]]):
                continue
        out.append(f"Face{i + 1}")
    return out


# ----------------------------------------------------------------------------- parameters & expressions

_IDENT = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\b")
_SAFE_FUNCS = {"sqrt": math.sqrt, "sin": lambda d: math.sin(math.radians(d)), "cos": lambda d: math.cos(math.radians(d)),
               "tan": lambda d: math.tan(math.radians(d)), "abs": abs, "min": min, "max": max, "pi": math.pi}


_UNITS = re.compile(r"(?<=[0-9.])\s*(mm|deg)\b")
_TOKENS = re.compile(r"\s*(\d+\.?\d*(?:[eE][-+]?\d+)?(?:\s*(?:mm|deg)\b)?|[A-Za-z_][A-Za-z0-9_.]*|\S)")


def _add_units(expr: str) -> str:
    """FreeCAD expressions are unit-checked: give bare numbers in +/- context 'mm' ('length - 5' -> 'length - 5 mm')."""
    toks = _TOKENS.findall(expr)
    out = []
    for i, t in enumerate(toks):
        if re.fullmatch(r"\d+\.?\d*(?:[eE][-+]?\d+)?", t):
            prev = toks[i - 1] if i > 0 else None
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if prev in (None, "+", "-", "(", ",") and nxt in (None, "+", "-", ")", ","):
                # unary minus at start, e.g. '-5', is still additive context
                t = f"{t} mm"
        out.append(t)
    return " ".join(out)


class Model:
    """A PartDesign Body driven by a `Params` spreadsheet."""

    def __init__(self, name: str = "Part", unitless: tuple[str, ...] = (), **params):
        self.doc = App.newDocument(name)
        overrides = _job_params()
        self.p: dict[str, float | str] = {}
        for k, v in params.items():
            v = overrides.get(k, v)
            self.p[k] = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v
        self.unitless = set(unitless)
        self.sheet = self.doc.addObject("Spreadsheet::Sheet", "Params")
        for row, (k, v) in enumerate(self.p.items(), start=1):
            self.sheet.set(f"A{row}", k)
            if isinstance(v, float):
                txt = f"{v:g}" if k in self.unitless else f"{v:g} mm"
            else:
                txt = str(v)
            self.sheet.set(f"B{row}", txt)
            self.sheet.setAlias(f"B{row}", k)
        self.doc.recompute()
        self.body = self.doc.addObject("PartDesign::Body", "Body")
        self._origin = {f.Role: f for f in self.body.Origin.OriginFeatures}

    # -- values ---------------------------------------------------------------------
    def value(self, v) -> tuple[float, str | None]:
        """Number -> (v, None). Expression string -> (evaluated, 'Params.x ...')."""
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v), None
        if not isinstance(v, str):
            raise TypeError(f"expected number or expression string, got {v!r}")
        expr = v.strip()
        unknown = [n for n in _IDENT.findall(_UNITS.sub("", expr)) if n not in self.p and n not in _SAFE_FUNCS]
        if unknown:
            raise NameError(f"unknown parameter(s) {unknown} in expression {expr!r}; known: {sorted(self.p)}")
        py_expr = _UNITS.sub("", expr)
        num = float(eval(py_expr, {"__builtins__": {}}, {**_SAFE_FUNCS, **self.p}))  # noqa: S307 - arithmetic over params
        fc = _IDENT.sub(lambda m: f"Params.{m.group(1)}" if m.group(1) in self.p else m.group(1), _add_units(expr))
        return num, fc

    def bind(self, obj, prop: str, v) -> float:
        num, fc = self.value(v)
        setattr(obj, prop, num) if "." not in prop else None
        if fc:
            obj.setExpression(prop, fc)
        return num

    # -- datums ----------------------------------------------------------------------
    def plane(self, which: str = "XY"):
        return self._origin[which.upper() + "_Plane"]

    def axis(self, which: str = "Z"):
        return self._origin[which.upper() + "_Axis"]

    def sketch(self, name: str, plane: str = "XY", offset=0.0) -> "Sketch":
        sk = self.body.newObject("Sketcher::SketchObject", name)
        sk.AttachmentSupport = [(self.plane(plane), "")]
        sk.MapMode = "FlatFace"
        num, fc = self.value(offset)
        if num or fc:
            sk.AttachmentOffset = App.Placement(App.Vector(0, 0, num), App.Rotation())
            if fc:
                sk.setExpression(".AttachmentOffset.Base.z", fc)
        return Sketch(self, sk)

    # -- features --------------------------------------------------------------------
    def _profile(self, s):
        sk = s.obj if isinstance(s, Sketch) else s
        sk.Visibility = False
        return sk

    def pad(self, sketch, length, name: str = "Pad", reversed: bool = False, symmetric: bool = False):
        f = self.body.newObject("PartDesign::Pad", name)
        f.Profile = self._profile(sketch)
        self.bind(f, "Length", length)
        f.Reversed, f.Midplane = reversed, symmetric
        return f

    def pocket(self, sketch, depth="through", name: str = "Pocket", reversed: bool = False, symmetric: bool | None = None):
        """depth='through' cuts through everything in both directions from the sketch plane."""
        f = self.body.newObject("PartDesign::Pocket", name)
        f.Profile = self._profile(sketch)
        if depth == "through":
            f.Type = "ThroughAll"
            f.Midplane = True if symmetric is None else symmetric
        else:
            self.bind(f, "Length", depth)
            f.Midplane = bool(symmetric)
        f.Reversed = reversed
        return f

    def revolve(self, sketch, angle=360.0, axis: str = "H", name: str = "Revolution", groove: bool = False):
        """Revolve about the sketch's horizontal ('H') or vertical ('V') axis."""
        f = self.body.newObject("PartDesign::Groove" if groove else "PartDesign::Revolution", name)
        sk = self._profile(sketch)
        f.Profile = sk
        f.ReferenceAxis = (sk, [f"{axis.upper()}_Axis"])
        self.bind(f, "Angle", angle)
        return f

    def _recompute_tip(self):
        self.doc.recompute()
        return self.body.Tip

    def fillet(self, select, radius, name: str = "Fillet"):
        """select: list of 'EdgeN', or a callable(shape) -> list (e.g. lambda s: cadkit.edges(s, parallel='Z'))."""
        base = self._recompute_tip()
        names = select(base.Shape) if callable(select) else list(select)
        if not names:
            raise ValueError(f"{name}: edge selector matched no edges")
        f = self.body.newObject("PartDesign::Fillet", name)
        f.Base = (base, names)
        self.bind(f, "Radius", radius)
        return f

    def chamfer(self, select, size, name: str = "Chamfer"):
        base = self._recompute_tip()
        names = select(base.Shape) if callable(select) else list(select)
        if not names:
            raise ValueError(f"{name}: edge selector matched no edges")
        f = self.body.newObject("PartDesign::Chamfer", name)
        f.Base = (base, names)
        self.bind(f, "Size", size)
        return f

    def polar_pattern(self, feature, count, angle=360.0, axis: str = "Z", name: str = "PolarPattern"):
        f = self.body.newObject("PartDesign::PolarPattern", name)
        f.Originals = [feature]
        f.Axis = (self.axis(axis), [""])
        self.bind(f, "Angle", angle)
        n, fc = self.value(count)
        f.Occurrences = int(round(n))
        if fc:
            f.setExpression("Occurrences", fc)
        self.body.Tip = f
        return f

    def linear_pattern(self, feature, length, count, direction: str = "X", name: str = "LinearPattern"):
        f = self.body.newObject("PartDesign::LinearPattern", name)
        f.Originals = [feature]
        f.Direction = (self.axis(direction), [""])
        self.bind(f, "Length", length)
        n, fc = self.value(count)
        f.Occurrences = int(round(n))
        if fc:
            f.setExpression("Occurrences", fc)
        self.body.Tip = f
        return f

    def mirror(self, feature, plane: str = "YZ", name: str = "Mirrored"):
        f = self.body.newObject("PartDesign::Mirrored", name)
        f.Originals = [feature]
        f.MirrorPlane = (self.plane(plane), [""])
        self.body.Tip = f
        return f

    def finish(self):
        """Recompute and return (doc, result_obj). Raises with the first failing feature's message."""
        self.doc.recompute()
        bad = [o for o in self.doc.Objects if "Invalid" in (o.State or [])]
        if bad:
            o = bad[0]
            raise RuntimeError(f"feature {o.Label} ({o.TypeId}) failed: {o.getStatusString()}")
        return self.doc, self.body


class Sketch:
    """Fully-constrained sketch builder. Coordinates are in the sketch plane (XY of the plane)."""

    def __init__(self, model: Model, obj):
        self.m, self.obj = model, obj
        self._named = 0

    def _name(self, idx, label):
        if label:
            self.obj.renameConstraint(idx, label)

    def _pin(self, g, pos, x, y, label=None):
        """Fix point (g,pos) at (x, y): numbers or expressions; zero snaps to the axes."""
        for coord, val, ctype, axis in (("X", x, "DistanceX", -2), ("Y", y, "DistanceY", -1)):
            num, fc = self.m.value(val)
            if fc is None and abs(num) < 1e-12:
                self.obj.addConstraint(Sketcher.Constraint("PointOnObject", g, pos, axis))
                continue
            i = self.obj.addConstraint(Sketcher.Constraint(ctype, -1, 1, g, pos, num))
            if fc:
                self.obj.setExpression(f"Constraints[{i}]", fc)
            if label:
                self._name(i, f"{label}{coord}")

    def rect(self, x, y, w, h, center: bool = False, label: str | None = None) -> list[int]:
        """Axis-aligned rectangle; (x, y) is the lower-left corner, or the centre if center=True."""
        if center:
            x = f"({x}) - ({w}) / 2" if isinstance(x, str) or isinstance(w, str) else x - w / 2
            y = f"({y}) - ({h}) / 2" if isinstance(y, str) or isinstance(h, str) else y - h / 2  # bare numbers get mm
        x0, _ = self.m.value(x)
        y0, _ = self.m.value(y)
        wn, wfc = self.m.value(w)
        hn, hfc = self.m.value(h)
        P = [App.Vector(x0, y0, 0), App.Vector(x0 + wn, y0, 0), App.Vector(x0 + wn, y0 + hn, 0), App.Vector(x0, y0 + hn, 0)]
        g0 = self.obj.GeometryCount
        ids = [self.obj.addGeometry(Part.LineSegment(P[i], P[(i + 1) % 4]), False) for i in range(4)]
        c = [Sketcher.Constraint("Coincident", ids[i], 2, ids[(i + 1) % 4], 1) for i in range(4)]
        c += [Sketcher.Constraint("Horizontal", ids[0]), Sketcher.Constraint("Horizontal", ids[2]),
              Sketcher.Constraint("Vertical", ids[1]), Sketcher.Constraint("Vertical", ids[3])]
        self.obj.addConstraint(c)
        iw = self.obj.addConstraint(Sketcher.Constraint("DistanceX", ids[0], 1, ids[0], 2, wn))
        ih = self.obj.addConstraint(Sketcher.Constraint("DistanceY", ids[1], 1, ids[1], 2, hn))
        if wfc:
            self.obj.setExpression(f"Constraints[{iw}]", wfc)
        if hfc:
            self.obj.setExpression(f"Constraints[{ih}]", hfc)
        if label:
            self._name(iw, f"{label}W")
            self._name(ih, f"{label}H")
        self._pin(ids[0], 1, x, y, label)
        assert g0 == ids[0]
        return ids

    def rounded_rect(self, x, y, w, h, r, center: bool = False, label: str | None = None) -> list[int]:
        """Rectangle with corner radius r drawn in the sketch — survives parameter changes, unlike
        edge-referencing fillets (topological naming). (x, y) = lower-left corner or centre."""
        if center:
            x = f"({x}) - ({w}) / 2" if isinstance(x, str) or isinstance(w, str) else x - w / 2
            y = f"({y}) - ({h}) / 2" if isinstance(y, str) or isinstance(h, str) else y - h / 2
        x0, _ = self.m.value(x)
        y0, _ = self.m.value(y)
        wn, wfc = self.m.value(w)
        hn, hfc = self.m.value(h)
        rn, rfc = self.m.value(r)
        if not (0 < rn < min(wn, hn) / 2):
            raise ValueError(f"corner radius {rn} must be > 0 and < half the smaller side ({min(wn, hn) / 2})")
        V = lambda a, b: App.Vector(a, b, 0)  # noqa: E731
        Z = App.Vector(0, 0, 1)
        g = self.obj.addGeometry
        bottom = g(Part.LineSegment(V(x0 + rn, y0), V(x0 + wn - rn, y0)), False)
        a_br = g(Part.ArcOfCircle(Part.Circle(V(x0 + wn - rn, y0 + rn), Z, rn), -math.pi / 2, 0), False)
        right = g(Part.LineSegment(V(x0 + wn, y0 + rn), V(x0 + wn, y0 + hn - rn)), False)
        a_tr = g(Part.ArcOfCircle(Part.Circle(V(x0 + wn - rn, y0 + hn - rn), Z, rn), 0, math.pi / 2), False)
        top = g(Part.LineSegment(V(x0 + wn - rn, y0 + hn), V(x0 + rn, y0 + hn)), False)
        a_tl = g(Part.ArcOfCircle(Part.Circle(V(x0 + rn, y0 + hn - rn), Z, rn), math.pi / 2, math.pi), False)
        left = g(Part.LineSegment(V(x0, y0 + hn - rn), V(x0, y0 + rn)), False)
        a_bl = g(Part.ArcOfCircle(Part.Circle(V(x0 + rn, y0 + rn), Z, rn), math.pi, 3 * math.pi / 2), False)
        C = Sketcher.Constraint
        ring = [bottom, a_br, right, a_tr, top, a_tl, left, a_bl]
        cons = [C("Tangent", ring[i], 2, ring[(i + 1) % 8], 1) for i in range(8)]
        cons += [C("Horizontal", bottom), C("Horizontal", top), C("Vertical", right), C("Vertical", left),
                 C("Equal", a_br, a_tr), C("Equal", a_tr, a_tl), C("Equal", a_tl, a_bl)]
        self.obj.addConstraint(cons)
        ir = self.obj.addConstraint(C("Radius", a_br, rn))
        iw = self.obj.addConstraint(C("DistanceX", left, 1, right, 1, wn))
        ih = self.obj.addConstraint(C("DistanceY", bottom, 1, top, 1, hn))
        for idx, fc in ((ir, rfc), (iw, wfc), (ih, hfc)):
            if fc:
                self.obj.setExpression(f"Constraints[{idx}]", fc)
        if label:
            self._name(iw, f"{label}W")
            self._name(ih, f"{label}H")
            self._name(ir, f"{label}R")
        # Pin the lower-left arc centre at (x + r, y + r).
        def plus(a, b):
            return f"({a}) + ({b})" if isinstance(a, str) or isinstance(b, str) else a + b
        self._pin(a_bl, 3, plus(x, r), plus(y, r), label)
        return ring

    def circle(self, cx, cy, d, label: str | None = None) -> int:
        """Circle by centre and *diameter*."""
        x, _ = self.m.value(cx)
        y, _ = self.m.value(cy)
        dn, dfc = self.m.value(d)
        g = self.obj.addGeometry(Part.Circle(App.Vector(x, y, 0), App.Vector(0, 0, 1), dn / 2), False)
        i = self.obj.addConstraint(Sketcher.Constraint("Diameter", g, dn))
        if dfc:
            self.obj.setExpression(f"Constraints[{i}]", dfc)
        if label:
            self._name(i, f"{label}D")
        self._pin(g, 3, cx, cy, label)
        return g

    def polygon(self, points, label: str | None = None) -> list[int]:
        """Closed polygon through points [(x, y), ...]; every vertex pinned (numbers or expressions)."""
        n = len(points)
        if n < 3:
            raise ValueError("polygon needs >= 3 points")
        num = [(self.m.value(px)[0], self.m.value(py)[0]) for px, py in points]
        ids = [self.obj.addGeometry(Part.LineSegment(App.Vector(*num[i], 0), App.Vector(*num[(i + 1) % n], 0)), False)
               for i in range(n)]
        self.obj.addConstraint([Sketcher.Constraint("Coincident", ids[i], 2, ids[(i + 1) % n], 1) for i in range(n)])
        for i, (px, py) in enumerate(points):
            self._pin(ids[i], 1, px, py, f"{label}P{i}" if label else None)
        return ids

    def slot(self, x1, y1, x2, y2, width) -> list[int]:
        """Straight slot (stadium) between two centre points — built as a polygon-approximated outline is avoided;
        uses two arcs + two lines with tangency."""
        a, _ = self.m.value(x1)
        b, _ = self.m.value(y1)
        c, _ = self.m.value(x2)
        d, _ = self.m.value(y2)
        wn, wfc = self.m.value(width)
        r = wn / 2
        ang = math.atan2(d - b, c - a)
        nx, ny = -math.sin(ang) * r, math.cos(ang) * r
        p1, p2 = App.Vector(a, b, 0), App.Vector(c, d, 0)
        arc1 = self.obj.addGeometry(Part.ArcOfCircle(Part.Circle(p1, App.Vector(0, 0, 1), r), ang + math.pi / 2, ang + 3 * math.pi / 2), False)
        arc2 = self.obj.addGeometry(Part.ArcOfCircle(Part.Circle(p2, App.Vector(0, 0, 1), r), ang - math.pi / 2, ang + math.pi / 2), False)
        l1 = self.obj.addGeometry(Part.LineSegment(App.Vector(a - nx, b - ny, 0), App.Vector(c - nx, d - ny, 0)), False)
        l2 = self.obj.addGeometry(Part.LineSegment(App.Vector(c + nx, d + ny, 0), App.Vector(a + nx, b + ny, 0)), False)
        self.obj.addConstraint([
            Sketcher.Constraint("Tangent", arc1, 2, l1, 1), Sketcher.Constraint("Tangent", l1, 2, arc2, 1),
            Sketcher.Constraint("Tangent", arc2, 2, l2, 1), Sketcher.Constraint("Tangent", l2, 2, arc1, 1),
            Sketcher.Constraint("Equal", arc1, arc2)])
        i = self.obj.addConstraint(Sketcher.Constraint("Diameter", arc1, wn))
        if wfc:
            self.obj.setExpression(f"Constraints[{i}]", wfc)
        self._pin(arc1, 3, x1, y1)
        self._pin(arc2, 3, x2, y2)
        return [arc1, arc2, l1, l2]


def _job_params() -> dict:
    """Request parameters injected by the runner (empty when used outside a job)."""
    import builtins

    return dict(getattr(builtins, "__cadkit_params__", {}) or {})
