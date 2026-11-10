# PartDesign: L-bracket from one constrained sketch (Pad), then a Fillet on the inner corner
# edge selected *by geometry* (robust against topological naming changes).
import FreeCAD as App
import Part
import Sketcher

p = {"leg": 40.0, "thickness": 5.0, "width": 30.0, "filletRadius": 4.0}
p.update({k: float(v) for k, v in params.items() if k in p})
a, t, w = p["leg"], p["thickness"], p["width"]

doc = App.newDocument("Bracket")
body = doc.addObject("PartDesign::Body", "Body")
xz = next(f for f in body.Origin.OriginFeatures if f.Role == "XZ_Plane")
sk = body.newObject("Sketcher::SketchObject", "LProfile")
sk.AttachmentSupport = [(xz, "")]
sk.MapMode = "FlatFace"
pts = [(0, 0), (a, 0), (a, t), (t, t), (t, a), (0, a)]
n = len(pts)
for i in range(n):
    (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % n]
    sk.addGeometry(Part.LineSegment(App.Vector(x0, y0, 0), App.Vector(x1, y1, 0)), False)
sk.addConstraint([Sketcher.Constraint("Coincident", i, 2, (i + 1) % n, 1) for i in range(n)])
sk.addConstraint([Sketcher.Constraint("Coincident", 0, 1, -1, 1)]
                 + [Sketcher.Constraint("Horizontal", i) for i in (0, 2, 4)]
                 + [Sketcher.Constraint("Vertical", i) for i in (1, 3, 5)])
sk.addConstraint([Sketcher.Constraint("DistanceX", 0, 1, 0, 2, a), Sketcher.Constraint("DistanceY", 5, 2, 5, 1, a),
                  Sketcher.Constraint("DistanceY", 1, 1, 1, 2, t), Sketcher.Constraint("DistanceX", -1, 1, 3, 1, t)])  # inner wall x = t
pad = body.newObject("PartDesign::Pad", "Bracket")
pad.Profile = sk
pad.Length = w
pad.Reversed = True  # XZ-plane sketch normal is -Y; reverse so the part extends toward +Y
sk.Visibility = False
doc.recompute()

# Inner corner edge: straight edge along Y through (x=t, z=t).
inner = [f"Edge{i + 1}" for i, e in enumerate(pad.Shape.Edges)
         if e.Curve.__class__.__name__ == "Line" and abs(e.BoundBox.XMin - t) < 1e-6 and abs(e.BoundBox.XMax - t) < 1e-6
         and abs(e.BoundBox.ZMin - t) < 1e-6 and abs(e.BoundBox.ZMax - t) < 1e-6]
fil = body.newObject("PartDesign::Fillet", "InnerFillet")
fil.Base = (pad, inner)
fil.Radius = p["filletRadius"]
doc.recompute()
result_obj = body
