# PartDesign Revolution: stepped shaft revolved about the sketch's horizontal (X) axis,
# then a chamfer on the end edge.
import FreeCAD as App
import Part
import Sketcher

p = {"d1": 20.0, "l1": 30.0, "d2": 12.0, "l2": 40.0, "chamfer": 1.0}
p.update({k: float(v) for k, v in params.items() if k in p})

doc = App.newDocument("Shaft")
body = doc.addObject("PartDesign::Body", "Body")
xz = next(f for f in body.Origin.OriginFeatures if f.Role == "XZ_Plane")
sk = body.newObject("Sketcher::SketchObject", "Profile")
sk.AttachmentSupport = [(xz, "")]
sk.MapMode = "FlatFace"
r1, r2, l1, l2 = p["d1"] / 2, p["d2"] / 2, p["l1"], p["l2"]
pts = [(0, 0), (l1 + l2, 0), (l1 + l2, r2), (l1, r2), (l1, r1), (0, r1)]
V = lambda x, y: App.Vector(x, y, 0)
for i in range(len(pts)):
    a, b = pts[i], pts[(i + 1) % len(pts)]
    sk.addGeometry(Part.LineSegment(V(*a), V(*b)), False)
n = len(pts)
sk.addConstraint([Sketcher.Constraint("Coincident", i, 2, (i + 1) % n, 1) for i in range(n)])
sk.addConstraint([Sketcher.Constraint("Coincident", 0, 1, -1, 1),  # start at origin
                  Sketcher.Constraint("PointOnObject", 0, 2, -1),  # bottom edge on X axis
                  Sketcher.Constraint("Horizontal", 2), Sketcher.Constraint("Horizontal", 4),
                  Sketcher.Constraint("Vertical", 1), Sketcher.Constraint("Vertical", 3), Sketcher.Constraint("Vertical", 5)])
sk.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 3, 1, l1))
sk.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, l1 + l2))
sk.addConstraint(Sketcher.Constraint("DistanceY", 1, 1, 1, 2, r2))
sk.addConstraint(Sketcher.Constraint("DistanceY", 5, 2, 5, 1, r1))  # line 5 runs (0,r1)->(0,0)

rev = body.newObject("PartDesign::Revolution", "Shaft")
rev.Profile = sk
rev.ReferenceAxis = (sk, ["H_Axis"])  # revolve about the sketch's horizontal axis
rev.Angle = 360.0
sk.Visibility = False
doc.recompute()

# Chamfer the circular edge at the small end (x = l1 + l2).
end_edges = [f"Edge{i + 1}" for i, e in enumerate(rev.Shape.Edges)
             if e.Curve.__class__.__name__ == "Circle" and abs(e.Curve.Center.x - (l1 + l2)) < 1e-6]
ch = body.newObject("PartDesign::Chamfer", "EndChamfer")
ch.Base = (rev, end_edges)
ch.Size = p["chamfer"]
doc.recompute()
result_obj = body
