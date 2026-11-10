---
name: freecad-design
description: Design mechanical parts in FreeCAD through the robust-freecad MCP server, with server-side validation and a rendered preview. Use when the user asks for a CAD part, STEP/FCStd file, bracket, plate, flange, enclosure or similar.
---

# FreeCAD design loop

Tools: `mcp__robust-freecad__search`, `mcp__robust-freecad__execute` (plus `job_status`, `artifacts`).

1. **Write the acceptance test first.** Turn the request into a `validation` object before writing any geometry:
   `expectedBoundingBoxMm` (X = length, Y = width, Z = thickness), `holes` (centres from the bounding-box min corner),
   `material`, `requireFullyConstrained`, and `flexTests` if the user wants an editable model.
   ISO 273 medium clearance: M3 3.4, M4 4.5, M5 5.5, M6 6.6, M8 9.0, M10 11.0 mm.
2. **Search once**, preferring `cadkit` examples: `search {query: "<part> holes"}`.
3. **Build in one `execute` call:**
   `const r = await cad.run({ exampleId | script, parameters, outputs: ['FCStd','STEP','PNG'], validation }); return { r, img: r.ok && await cad.preview(r.id) };`
4. **Repair without resending the script** while `r.ok` is false (at most 3 times):
   `cad.run({ fromJob: r.id, parameters: {...} })` or `cad.run({ fromJob: r.id, patch: [{ find, replace }] })`.
   Read `failed[]` (expected vs actual) before changing anything.
5. **Look at the render.** Check feature counts, positions and through-holes against the request before you report.
6. Report the job id, `checks.passed/total`, mass, and the STEP/FCStd artifact ids. Never claim success without `r.ok`.

Plain-English only? If the server runs with `FREECAD_MCP_DESIGN=1`, the `design` tool does all of this server-side.
