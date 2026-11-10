# Enclosure lid with cadkit: centred plate, counterbored corner screw holes, a slot, chamfered top edges.
m = cadkit.Model("Lid", length=100, width=60, thickness=4, hole=cadkit.clearance("M3"), cb=cadkit.counterbore("M3")[0],
                 cb_depth=2, inset=6, slot_len=30, slot_w=5)
plate = m.sketch("Plate")
plate.rect(0, 0, "length", "width", center=True)
m.pad(plate, "thickness", name="Lid")
corners = [("length/2 - inset", "width/2 - inset"), ("-(length/2 - inset)", "width/2 - inset"),
           ("length/2 - inset", "-(width/2 - inset)"), ("-(length/2 - inset)", "-(width/2 - inset)")]
holes = m.sketch("Holes")
for x, y in corners:
    holes.circle(x, y, "hole")
m.pocket(holes)
cbores = m.sketch("Counterbores", offset="thickness")  # sketch on the top face plane
for x, y in corners:
    cbores.circle(x, y, "cb")
m.pocket(cbores, depth="cb_depth")  # pockets go down (-Z) from the top plane
slot = m.sketch("Slot")
slot.slot("-slot_len/2", 0, "slot_len/2", 0, "slot_w")
m.pocket(slot)
m.chamfer(lambda s: cadkit.edges(s, kind="line", at={"z": s.BoundBox.ZMax}), 0.5, name="TopChamfer")
doc, result_obj = m.finish()
