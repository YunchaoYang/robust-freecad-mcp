# Part workbench, parametric document objects: box minus a cylinder (a bored block).
# Primitives (Part::Box, Part::Cylinder) and booleans (Part::Cut) stay editable in the FCStd.
import FreeCAD as App

p = {"length": 60.0, "width": 40.0, "height": 20.0, "boreDiameter": 16.0}
p.update({k: float(v) for k, v in params.items() if k in p})

doc = App.newDocument("BoredBlock")
box = doc.addObject("Part::Box", "Block")
box.Length, box.Width, box.Height = p["length"], p["width"], p["height"]

bore = doc.addObject("Part::Cylinder", "Bore")
bore.Radius = p["boreDiameter"] / 2
bore.Height = p["height"] + 2  # overshoot both faces to avoid coplanar boolean faces
bore.Placement.Base = App.Vector(p["length"] / 2, p["width"] / 2, -1)
# Keep the bore centred when the block changes size:
bore.setExpression(".Placement.Base.x", "Block.Length / 2")
bore.setExpression(".Placement.Base.y", "Block.Width / 2")
bore.setExpression("Height", "Block.Height + 2 mm")

cut = doc.addObject("Part::Cut", "BoredBlock")
cut.Base, cut.Tool = box, bore
doc.recompute()
result_obj = cut
