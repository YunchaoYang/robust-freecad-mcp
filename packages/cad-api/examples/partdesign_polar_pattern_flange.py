# PartDesign PolarPattern: round flange (Pad of a circle) with one bolt hole (Pocket)
# patterned N times around the Z axis, plus a centre bore.
import FreeCAD as App
import Part
import Sketcher

p = {"outerDiameter": 100.0, "thickness": 8.0, "boreDiameter": 30.0, "pcd": 75.0, "holeDiameter": 9.0, "holes": 6}
p.update({k: float(v) for k, v in params.items() if k in p})

doc = App.newDocument("Flange")
body = doc.addObject("PartDesign::Body", "Body")
xy = next(f for f in body.Origin.OriginFeatures if f.Role == "XY_Plane")
z_axis = next(f for f in body.Origin.OriginFeatures if f.Role == "Z_Axis")


def sketch(name):
    s = body.newObject("Sketcher::SketchObject", name)
    s.AttachmentSupport = [(xy, "")]
    s.MapMode = "FlatFace"
    return s


disc = sketch("DiscSketch")
c0 = disc.addGeometry(Part.Circle(App.Vector(0, 0, 0), App.Vector(0, 0, 1), p["outerDiameter"] / 2), False)
c1 = disc.addGeometry(Part.Circle(App.Vector(0, 0, 0), App.Vector(0, 0, 1), p["boreDiameter"] / 2), False)
disc.addConstraint([Sketcher.Constraint("Coincident", c0, 3, -1, 1), Sketcher.Constraint("Coincident", c1, 3, -1, 1),
                    Sketcher.Constraint("Diameter", c0, p["outerDiameter"]), Sketcher.Constraint("Diameter", c1, p["boreDiameter"])])
pad = body.newObject("PartDesign::Pad", "Disc")  # nested circles -> annulus (inner wire becomes the bore)
pad.Profile = disc
pad.Length = p["thickness"]

hole = sketch("BoltHoleSketch")
h = hole.addGeometry(Part.Circle(App.Vector(p["pcd"] / 2, 0, 0), App.Vector(0, 0, 1), p["holeDiameter"] / 2), False)
hole.addConstraint([Sketcher.Constraint("PointOnObject", h, 3, -1),  # centre on the X axis
                    Sketcher.Constraint("DistanceX", -1, 1, h, 3, p["pcd"] / 2),
                    Sketcher.Constraint("Diameter", h, p["holeDiameter"])])
pocket = body.newObject("PartDesign::Pocket", "BoltHole")
pocket.Profile = hole
pocket.Type = "ThroughAll"
pocket.Midplane = True

pattern = body.newObject("PartDesign::PolarPattern", "BoltPattern")
pattern.Originals = [pocket]
pattern.Axis = (z_axis, [""])
pattern.Angle = 360.0
pattern.Occurrences = int(p["holes"])
body.Tip = pattern
for o in (disc, hole):
    o.Visibility = False
doc.recompute()
result_obj = body
