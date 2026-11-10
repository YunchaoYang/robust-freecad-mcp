# Part shape API (non-parametric): fast scripted geometry with Part.make* + booleans + fillets.
# The FCStd will contain only a baked Part::Feature - use PartDesign or Part objects when the
# result must stay editable (validation.requireParametric).
import FreeCAD as App
import Part

L, W, H, r = 50.0, 30.0, 12.0, 2.0
block = Part.makeBox(L, W, H)
# Fillet the four vertical edges (edges parallel to Z).
vertical = [e for e in block.Edges if abs(e.tangentAt(e.FirstParameter).z) > 0.999]
block = block.makeFillet(r, vertical)
slot = Part.makeBox(30, 8, H + 2, App.Vector(10, 11, -1))
shape = block.cut(slot).removeSplitter()  # removeSplitter merges coplanar faces after booleans

doc = App.newDocument("ShapeApi")
result_obj = shape  # a bare Part.Shape is wrapped into a Part::Feature named "Result"
