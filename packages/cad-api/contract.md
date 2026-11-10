# FreeCAD job contract (FreeCAD 1.1.3, headless)

## Script
- Runs as FreeCAD Python in a sandbox. Pre-bound globals: `App` / `FreeCAD`, `Part`, `Sketcher`, `params` (dict from `request.parameters`), and **`cadkit`**, a tested helper library: prefer it. See `api.cadkit.model` and `example.cadkit.mounting_plate`. You can also `import PartDesign, Spreadsheet, Mesh, math`.
- You **must** define:
  - `doc`: the document you built (`doc = App.newDocument("Name")`).
  - `result_obj`: the final object whose `.Shape` is the part. Use the `PartDesign::Body` for PartDesign. A bare `Part.Shape` is wrapped in a `Part::Feature` named `Result`.
- The runner calls `doc.recompute()`, reports features in error, then exports `model.FCStd` / `model.step` / `model.stl`. Don't save or export files yourself.
- Units are millimetres. There is no GUI (`FreeCADGui`, `ViewObject`, screenshots), no network, no subprocesses, and no file access outside the job directory.
- For editable results, prefer PartDesign Body + constrained Sketches driven by a `Spreadsheet::Sheet`, and set `validation.requireParametric: true`.

## Validation (`request.validation`)
The checks run on the **re-imported** STEP (or FCStd) in a fresh process that runs none of your code.

| field | meaning |
|---|---|
| `requireValidShape` (true) | `Shape.isValid()` |
| `requireSolid` (true) | at least one solid |
| `expectedSolidCount` | exact solid count |
| `expectedBoundingBoxMm` `[x,y,z]` | extents, within `toleranceMm` (0.01) |
| `expectedVolumeMm3`, `volumeTolerancePct` (0.5) | volume |
| `holes[]` `{diameterMm, centersMm:[[a,b],…], axis:"z", reference:"bboxMin"\|"origin", through:true}` | concave cylindrical holes at those centres |
| `expectedHoleCount` | number of holes detected along the axes in `holes` |
| `requireParametric` | the FCStd has constrained sketches or expressions, not a baked shape |
| `reportHoles` | include `detectedHoles` (Z axis) in the result |
| `material` (e.g. `aluminum_6061`, `steel`, `pla`) | adds `massProperties.massG`. Centre of mass is always reported. |
| `maxMassG` | mass budget (requires `material`) |
| `requireFullyConstrained` | every sketch has 0 degrees of freedom and no conflicts |
| `flexTests[]` `{name?, set:{alias: value}, expect?:{boundingBoxMm, volumeMm3, holeCount}}` | re-open the saved FCStd, change `Params` aliases, recompute, re-check. Proves the model survives edits. Needs FCStd. |

Add `"PNG"` to `outputs` to get a rendered 4-view preview (`preview.png`): hidden lines removed, dimensions shown, no GUI needed.

Each check is reported as `{name, passed, expected, actual, message}`. If any check fails, the job ends with `VALIDATION_FAILED` and no artifacts are published.

## Repairing failures
| code | what to do |
|---|---|
| `SCRIPT_SYNTAX_ERROR` | fix the reported line/column |
| `SCRIPT_ERROR` | read `traceback`: job-script frames only, with source lines |
| `SCRIPT_CONTRACT` | define `doc` and `result_obj` |
| `RECOMPUTE_ERROR` | `featureErrors[]` names the failing feature and FreeCAD's message (sketch conflicts list 1-based constraint numbers) |
| `EXPORT_FAILED` | the result shape is empty or invalid |
| `VALIDATION_FAILED` | compare `checks[].expected` with `checks[].actual` |
| `TIMEOUT` / `WORKER_CRASHED` | simplify booleans/fillets; overshoot cutting tools by ≥1 mm |

## Minimal script
```python
doc = App.newDocument("Plate")
body = doc.addObject("PartDesign::Body", "Body")
xy = next(f for f in body.Origin.OriginFeatures if f.Role == "XY_Plane")
sk = body.newObject("Sketcher::SketchObject", "Outline")
sk.AttachmentSupport = [(xy, "")]; sk.MapMode = "FlatFace"
# ... addGeometry / addConstraint ...
pad = body.newObject("PartDesign::Pad", "Pad"); pad.Profile = sk; pad.Length = 10
doc.recompute()
result_obj = body
```
The same plate with cadkit (fully constrained, spreadsheet-driven):
```python
m = cadkit.Model("Plate", length=120, width=80, thickness=10, hole=cadkit.clearance("M6"), edge=12, corner=3)
s = m.sketch("Outline"); s.rounded_rect(0, 0, "length", "width", "corner")
m.pad(s, "thickness")
h = m.sketch("Holes")
for x, y in [("edge", "edge"), ("length - edge", "edge"), ("edge", "width - edge"), ("length - edge", "width - edge")]:
    h.circle(x, y, "hole")
m.pocket(h)
doc, result_obj = m.finish()
```
For complete tested scripts, search for `mounting plate` (`example.cadkit.mounting_plate`, `example.partdesign.mounting_plate`).
