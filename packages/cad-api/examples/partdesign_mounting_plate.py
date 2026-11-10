# Parametric mounting plate: PartDesign Body + constrained sketches driven by a spreadsheet.
# Defaults: 120 x 80 x 10 mm plate, four M6 clearance holes (6.6 mm, ISO 273 medium), 12 mm from edges.
# Override any value through request.parameters, e.g. {"length": 150, "holeDiameter": 9}.
import FreeCAD as App
import Part
import Sketcher

p = {"length": 120.0, "width": 80.0, "thickness": 10.0, "holeDiameter": 6.6, "edgeOffset": 12.0}
p.update({k: float(v) for k, v in params.items() if k in p})  # `params` is injected by the runner

doc = App.newDocument("MountingPlate")

# --- Parameters live in a spreadsheet so the FCStd stays editable --------------
sheet = doc.addObject("Spreadsheet::Sheet", "Params")
for row, (alias, value) in enumerate(p.items(), start=1):
    sheet.set(f"A{row}", alias)
    sheet.set(f"B{row}", f"{value} mm")
    sheet.setAlias(f"B{row}", alias)
doc.recompute()

body = doc.addObject("PartDesign::Body", "Body")
xy_plane = next(f for f in body.Origin.OriginFeatures if f.Role == "XY_Plane")


def rect_sketch(name):
    sk = body.newObject("Sketcher::SketchObject", name)
    sk.AttachmentSupport = [(xy_plane, "")]
    sk.MapMode = "FlatFace"
    L, W = p["length"], p["width"]
    pts = [App.Vector(0, 0, 0), App.Vector(L, 0, 0), App.Vector(L, W, 0), App.Vector(0, W, 0)]
    for i in range(4):
        sk.addGeometry(Part.LineSegment(pts[i], pts[(i + 1) % 4]), False)
    cons = [Sketcher.Constraint("Coincident", i, 2, (i + 1) % 4, 1) for i in range(4)]
    cons += [Sketcher.Constraint("Horizontal", 0), Sketcher.Constraint("Horizontal", 2),
             Sketcher.Constraint("Vertical", 1), Sketcher.Constraint("Vertical", 3),
             Sketcher.Constraint("Coincident", 0, 1, -1, 1)]  # corner on origin
    sk.addConstraint(cons)
    c_len = sk.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, L))
    c_wid = sk.addConstraint(Sketcher.Constraint("DistanceY", 1, 1, 1, 2, W))
    sk.renameConstraint(c_len, "Length")
    sk.renameConstraint(c_wid, "Width")
    sk.setExpression(".Constraints.Length", "Params.length")
    sk.setExpression(".Constraints.Width", "Params.width")
    return sk


outline = rect_sketch("PlateSketch")
pad = body.newObject("PartDesign::Pad", "Plate")
pad.Profile = outline
pad.Length = p["thickness"]
pad.setExpression("Length", "Params.thickness")
outline.Visibility = False

# --- Hole sketch: four circles, positions/diameter bound to the spreadsheet ----
holes = body.newObject("Sketcher::SketchObject", "HoleSketch")
holes.AttachmentSupport = [(xy_plane, "")]
holes.MapMode = "FlatFace"
L, W, e, d = p["length"], p["width"], p["edgeOffset"], p["holeDiameter"]
centers = [(e, e, "", ""), (L - e, e, "Params.length - Params.edgeOffset", ""),
           (e, W - e, "", "Params.width - Params.edgeOffset"),
           (L - e, W - e, "Params.length - Params.edgeOffset", "Params.width - Params.edgeOffset")]
for i, (x, y, ex, ey) in enumerate(centers):
    g = holes.addGeometry(Part.Circle(App.Vector(x, y, 0), App.Vector(0, 0, 1), d / 2), False)
    cx = holes.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, g, 3, x))
    cy = holes.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, g, 3, y))
    cd = holes.addConstraint(Sketcher.Constraint("Diameter", g, d))
    holes.renameConstraint(cx, f"Hole{i}X")
    holes.renameConstraint(cy, f"Hole{i}Y")
    holes.renameConstraint(cd, f"Hole{i}D")
    holes.setExpression(f".Constraints.Hole{i}X", ex or "Params.edgeOffset")
    holes.setExpression(f".Constraints.Hole{i}Y", ey or "Params.edgeOffset")
    holes.setExpression(f".Constraints.Hole{i}D", "Params.holeDiameter")

pocket = body.newObject("PartDesign::Pocket", "Holes")
pocket.Profile = holes
pocket.Type = "ThroughAll"
pocket.Midplane = True  # cut both directions from the XY plane: robust "through all"
holes.Visibility = False

doc.recompute()
result_obj = body  # the Body's Shape is its Tip feature (the pocket)
