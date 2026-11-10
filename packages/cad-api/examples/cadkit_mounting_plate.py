# The four-hole mounting plate with cadkit: fully constrained, spreadsheet-driven, ~10 lines.
# Corner radii are drawn in the sketch (not a Fillet on EdgeN) so the model survives parameter changes.
# Override any parameter via request.parameters, e.g. {"length": 150, "bolt": ...} (numbers only).
m = cadkit.Model("MountingPlate", length=120, width=80, thickness=10, hole=cadkit.clearance("M6"), edge=12, corner=3)
outline = m.sketch("Outline")
outline.rounded_rect(0, 0, "length", "width", "corner", label="Plate")  # corner radii live in the sketch
m.pad(outline, "thickness", name="Plate")
holes = m.sketch("Holes")
for i, (x, y) in enumerate([("edge", "edge"), ("length - edge", "edge"), ("edge", "width - edge"), ("length - edge", "width - edge")]):
    holes.circle(x, y, "hole", label=f"Hole{i}")
m.pocket(holes)  # through all
doc, result_obj = m.finish()
