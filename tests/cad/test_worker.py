"""Phase-1 gate tests for the FreeCAD worker. Run with:  python3 -m unittest discover -s tests/cad -v

Uses the real FreeCAD runtime (FREECAD_MCP_PYTHON or ~/micromamba/envs/freecad-mcp/bin/python).
"""

from __future__ import annotations

import json
import os
import subprocess
import textwrap
import unittest

from harness import EXAMPLES, PYTHON, example, run_job

PLATE_VALIDATION = {
    "requireValidShape": True,
    "requireSolid": True,
    "requireParametric": True,
    "expectedBoundingBoxMm": [120, 80, 10],
    "expectedVolumeMm3": 120 * 80 * 10 - 4 * 3.141592653589793 * 3.3**2 * 10,
    "volumeTolerancePct": 0.01,
    "expectedSolidCount": 1,
    "holes": [{"diameterMm": 6.6, "centersMm": [[12, 12], [108, 12], [12, 68], [108, 68]], "through": True}],
    "expectedHoleCount": 4,
}


def freecad_eval(code: str) -> dict:
    """Run trusted FreeCAD code (outside the sandbox) and return the JSON it prints last."""
    env = {"PATH": "/usr/bin:/bin", "QT_QPA_PLATFORM": "offscreen", "HOME": os.environ.get("TMPDIR", "/tmp")}
    prelude = f"import sys; sys.path.append({os.path.join(os.path.dirname(os.path.dirname(PYTHON)), 'lib')!r})\n"
    p = subprocess.run([PYTHON, "-I", "-c", prelude + textwrap.dedent(code)], capture_output=True, text=True, env=env, timeout=180)
    lines = [l for l in p.stdout.splitlines() if l.startswith("{")]
    if p.returncode != 0 or not lines:
        raise AssertionError(f"freecad_eval failed ({p.returncode}): {p.stderr[-2000:]}")
    return json.loads(lines[-1])


def failed_checks(verify: dict) -> list[str]:
    return [c["name"] for c in verify.get("checks", []) if not c["passed"]]


class MountingPlateGate(unittest.TestCase):
    """Gate: plate opens in FreeCAD and a separate STEP importer; geometry and dimensions pass."""

    @classmethod
    def setUpClass(cls):
        cls.r = run_job(example("partdesign_mounting_plate.py"), outputs=("FCStd", "STEP", "STL"), validation=PLATE_VALIDATION)
        cls.out = os.path.join(cls.r["work"], "out")

    def test_build_ok_and_sandboxed(self):
        b = self.r["build"]
        self.assertTrue(b["ok"], b.get("error"))
        self.assertTrue(b["sandbox"]["enforced"])
        self.assertTrue(b["freecadVersion"].startswith("1.1"))
        for e in b["exports"]:
            self.assertTrue(e["ok"] and e["sizeBytes"] > 0, e)

    def test_all_checks_pass(self):
        v = self.r["verify"]
        self.assertTrue(v["ok"], v.get("error"))
        self.assertEqual(failed_checks(v), [])
        self.assertEqual(v["geometry"]["boundingBoxMm"], [120.0, 80.0, 10.0])
        self.assertEqual(v["geometry"]["solidCount"], 1)
        names = {c["name"] for c in v["checks"]}
        self.assertTrue({"boundingBox", "volume", "holeCount", "parametric.featureTree", "artifact.STEP.readable"} <= names)

    def test_step_opens_in_separate_importer(self):
        # FreeCAD's Import module (OCAF/XCAF STEP reader) is a different code path than Part.read used in verify.
        res = freecad_eval(f"""
            import json, FreeCAD as App, Import
            doc = App.newDocument("imp")
            Import.insert({os.path.join(self.out, 'model.step')!r}, doc.Name)
            shapes = [o.Shape for o in doc.Objects if hasattr(o, 'Shape') and not o.Shape.isNull() and o.Shape.Solids]
            s = shapes[0]
            bb = s.BoundBox
            print(json.dumps({{"n": len(shapes), "valid": s.isValid(), "vol": s.Volume, "bb": [bb.XLength, bb.YLength, bb.ZLength]}}))
        """)
        self.assertGreaterEqual(res["n"], 1)
        self.assertTrue(res["valid"])
        self.assertAlmostEqual(res["vol"], PLATE_VALIDATION["expectedVolumeMm3"], delta=1.0)
        for a, e in zip(res["bb"], [120, 80, 10]):
            self.assertAlmostEqual(a, e, places=3)

    def test_fcstd_is_parametrically_editable(self):
        res = freecad_eval(f"""
            import json, FreeCAD as App
            doc = App.openDocument({os.path.join(self.out, 'model.FCStd')!r})
            sheet = doc.getObject("Params")
            sheet.set("B1", "150 mm")      # length
            sheet.set("B4", "9 mm")        # holeDiameter
            doc.recompute()
            body = doc.getObject("Body")
            bb = body.Shape.BoundBox
            holes = [f for f in body.Shape.Faces if f.Surface.__class__.__name__ == "Cylinder"]
            print(json.dumps({{"bb": [bb.XLength, bb.YLength, bb.ZLength], "valid": body.Shape.isValid(),
                               "radii": sorted({{round(f.Surface.Radius, 4) for f in holes}}),
                               "maxX": max(f.Surface.Center.x for f in holes)}}))
        """)
        self.assertEqual([round(x, 3) for x in res["bb"]], [150, 80, 10])
        self.assertTrue(res["valid"])
        self.assertEqual(res["radii"], [4.5])
        self.assertAlmostEqual(res["maxX"], 150 - 12, places=3)  # holes track the new edge

    def test_stl_watertight(self):
        stl = next(a for a in self.r["verify"]["artifactChecks"] if a["format"] == "STL")
        self.assertTrue(stl["watertight"])
        self.assertGreater(stl["facets"], 0)


class ExamplesBuild(unittest.TestCase):
    """Every curated catalog example must build, validate and export."""

    def test_examples(self):
        expectations = {
            "partdesign_mounting_plate.py": {"bb": [120, 80, 10], "holes": [6.6] * 4, "parametric": True},
            "partdesign_polar_pattern_flange.py": {"bb": [100, 100, 8], "holes": [9.0] * 6 + [30.0], "parametric": True},
            "partdesign_revolution_shaft.py": {"bb": [70, 20, 20], "holes": [], "parametric": True},
            "partdesign_fillet_bracket.py": {"bb": [40, 30, 40], "holes": [], "parametric": True},
            "part_primitives_boolean.py": {"bb": [60, 40, 20], "holes": [16.0], "parametric": True},
            "part_shape_api.py": {"bb": [50, 30, 12], "holes": [], "parametric": False},
            "cadkit_mounting_plate.py": {"bb": [120, 80, 10], "holes": [6.6] * 4, "parametric": True},
            "cadkit_enclosure_lid.py": {"bb": [100, 60, 4], "holes": [3.4] * 4 + [6.5] * 4, "parametric": True},
        }
        listed = sorted(f for f in os.listdir(EXAMPLES) if f.endswith(".py"))
        self.assertEqual(sorted(expectations), listed, "every example needs an expectation here")
        for name, exp in expectations.items():
            with self.subTest(example=name):
                r = run_job(example(name), outputs=("FCStd", "STEP"), validation={
                    "expectedBoundingBoxMm": exp["bb"], "requireParametric": exp["parametric"], "reportHoles": True})
                self.assertTrue(r["build"].get("ok"), r["build"].get("error"))
                v = r["verify"]
                self.assertTrue(v["ok"], v.get("error"))
                self.assertEqual(sorted(h["diameterMm"] for h in v["detectedHoles"]), sorted(exp["holes"]))


class ActionableFailures(unittest.TestCase):
    def test_syntax_error(self):
        b = run_job("doc = App.newDocument('x'\nresult_obj = None")["build"]
        self.assertEqual(b["error"]["code"], "SCRIPT_SYNTAX_ERROR")
        self.assertIn("line", b["error"]["message"])

    def test_runtime_error_has_script_line(self):
        b = run_job("doc = App.newDocument('x')\nbox = Part.makeBox(1, 1, 1)\nbox.no_such_method()\n")["build"]
        self.assertEqual(b["error"]["code"], "SCRIPT_ERROR")
        self.assertIn("line 3", b["error"]["traceback"])
        self.assertIn("no_such_method", b["error"]["traceback"])

    def test_import_app_resolves_to_freecad(self):
        # Regression (local-model eval): `import App` used to pick up an unrelated module named App.
        script = "import App\nimport FreeCAD as FC\nimport Part\ndoc = App.newDocument('x')\nresult_obj = doc.addObject('Part::Box', 'B')\nassert App is FC\n"
        r = run_job(script, outputs=("STEP",), validation={"expectedBoundingBoxMm": [10, 10, 10]})
        self.assertTrue(r["build"]["ok"], r["build"].get("error"))
        self.assertTrue(r["verify"]["ok"], failed_checks(r["verify"]))

    def test_contract_missing_result(self):
        b = run_job("doc = App.newDocument('x')\nPart.makeBox(1, 1, 1)\n")["build"]
        self.assertEqual(b["error"]["code"], "SCRIPT_CONTRACT")

    def test_recompute_error_names_feature(self):
        script = textwrap.dedent("""
            doc = App.newDocument('x')
            body = doc.addObject('PartDesign::Body', 'Body')
            pad = body.newObject('PartDesign::Pad', 'PadWithoutProfile')
            doc.recompute()
            result_obj = body
        """)
        b = run_job(script)["build"]
        self.assertIn(b["error"]["code"], ("RECOMPUTE_ERROR", "EXPORT_FAILED"))
        self.assertTrue(any(fe["name"] == "PadWithoutProfile" for fe in b.get("featureErrors", [])), b)

    def test_validation_failure_reports_expected_vs_actual(self):
        r = run_job(example("partdesign_mounting_plate.py"), validation={
            "expectedBoundingBoxMm": [80, 120, 10],
            "holes": [{"diameterMm": 6.6, "centersMm": [[10, 10]]}],
        })
        v = r["verify"]
        self.assertFalse(v["ok"])
        self.assertEqual(v["error"]["code"], "VALIDATION_FAILED")
        bb = next(c for c in v["checks"] if c["name"] == "boundingBox")
        self.assertEqual(bb["actual"], [120.0, 80.0, 10.0])
        self.assertIn("different axes", bb["message"])
        hole = next(c for c in v["checks"] if c["name"].startswith("hole[0]"))
        self.assertFalse(hole["passed"])
        self.assertEqual(hole["actual"]["center"], [12.0, 12.0])

    def test_parameters_reach_script(self):
        r = run_job(example("partdesign_mounting_plate.py"), parameters={"length": 200, "edgeOffset": 20},
                    validation={"expectedBoundingBoxMm": [200, 80, 10],
                                "holes": [{"diameterMm": 6.6, "centersMm": [[20, 20], [180, 60]]}]})
        self.assertTrue(r["verify"]["ok"], r["verify"].get("error"))

    def test_non_parametric_rejected_when_required(self):
        v = run_job(example("part_shape_api.py"), validation={"requireParametric": True})["verify"]
        self.assertIn("parametric.featureTree", failed_checks(v))


class EngineeringChecks(unittest.TestCase):
    """Features no other FreeCAD MCP server combines: mass, DoF, flex tests, previews, cadkit."""

    @classmethod
    def setUpClass(cls):
        cls.r = run_job(example("cadkit_mounting_plate.py"), outputs=("FCStd", "STEP", "PNG"), validation={
            "material": "aluminum_6061", "maxMassG": 300, "requireFullyConstrained": True,
            "flexTests": [{"name": "longer", "set": {"length": 160, "hole": 9},
                           "expect": {"boundingBoxMm": [160, 80, 10], "holeCount": 4}}]})
        cls.v = cls.r["verify"]

    def test_all_pass(self):
        self.assertTrue(self.v["ok"], self.v.get("error"))

    def test_mass_properties(self):
        mp = self.v["massProperties"]
        self.assertAlmostEqual(mp["massG"], mp["volumeMm3"] * 2.70 / 1000, places=2)
        self.assertEqual(mp["centerOfMassMm"], [60.0, 40.0, 5.0])

    def test_sketches_fully_constrained(self):
        sk = self.v["featureTree"]["sketches"]
        self.assertTrue(sk and all(s["dof"] == 0 for s in sk), sk)

    def test_flex_rebuild(self):
        self.assertEqual(self.v["flexResults"][0]["boundingBoxMm"], [160.0, 80.0, 10.0])

    def test_preview_png(self):
        png = next(a for a in self.v["artifactChecks"] if a["format"] == "PNG")
        self.assertTrue(png["rendered"])
        self.assertGreater(png["nonBlankFraction"], 0.02)
        with open(os.path.join(self.r["work"], "out", "preview.png"), "rb") as f:
            self.assertEqual(f.read(8), b"\x89PNG\r\n\x1a\n")

    def test_mass_budget_violation(self):
        v = run_job(example("cadkit_mounting_plate.py"), outputs=("STEP",), validation={"material": "steel", "maxMassG": 300})["verify"]
        self.assertEqual(failed_checks(v), ["mass.max"])

    def test_underconstrained_sketch_detected(self):
        script = textwrap.dedent("""
            doc = App.newDocument('x')
            body = doc.addObject('PartDesign::Body', 'Body')
            xy = next(f for f in body.Origin.OriginFeatures if f.Role == 'XY_Plane')
            sk = body.newObject('Sketcher::SketchObject', 'Loose')
            sk.AttachmentSupport = [(xy, '')]; sk.MapMode = 'FlatFace'
            sk.addGeometry(Part.Circle(App.Vector(5, 5, 0), App.Vector(0, 0, 1), 4))  # no constraints at all
            pad = body.newObject('PartDesign::Pad', 'Pad'); pad.Profile = sk; pad.Length = 3
            doc.recompute(); result_obj = body
        """)
        v = run_job(script, outputs=("FCStd", "STEP"), validation={"requireFullyConstrained": True})["verify"]
        chk = next(c for c in v["checks"] if c["name"] == "sketch.Loose.fullyConstrained")
        self.assertFalse(chk["passed"])
        self.assertEqual(chk["actual"], 3)  # circle: x, y, r

    def test_flex_catches_fragile_edge_fillet(self):
        # A Fillet on hard-coded/selected EdgeN breaks when the length changes (topological naming).
        script = example("cadkit_mounting_plate.py").replace(
            'outline.rounded_rect(0, 0, "length", "width", "corner", label="Plate")', 'outline.rect(0, 0, "length", "width")').replace(
            "doc, result_obj = m.finish()", 'm.fillet(lambda s: cadkit.edges(s, kind="line", parallel="Z"), 3)\ndoc, result_obj = m.finish()')
        r = run_job(script, outputs=("FCStd", "STEP"), validation={"flexTests": [{"set": {"length": 160}}]})
        self.assertTrue(r["build"]["ok"], r["build"].get("error"))
        self.assertIn("flex[0].rebuilds", failed_checks(r["verify"]))

    def test_cadkit_units_and_standards(self):
        script = textwrap.dedent("""
            assert cadkit.clearance("M6") == 6.6 and cadkit.tap_drill("M8") == 6.8 and cadkit.counterbore("M4") == (8.0, 4.4)
            m = cadkit.Model("U", a=40, b=20)
            s = m.sketch("S"); s.rect("-a/2", "-(b - 4)", "a", "b - 4 + 4")   # bare numbers in +/- context get mm
            m.pad(s, "b / 4")
            doc, result_obj = m.finish()
        """)
        r = run_job(script, outputs=("STEP",), validation={"expectedBoundingBoxMm": [40, 20, 5]})
        self.assertTrue(r["build"]["ok"], r["build"].get("error"))
        self.assertTrue(r["verify"]["ok"], r["verify"].get("error"))

    def test_slot_ends_are_not_holes(self):
        v = run_job(example("cadkit_enclosure_lid.py"), outputs=("STEP",), validation={"reportHoles": True})["verify"]
        self.assertNotIn(5.0, [h["diameterMm"] for h in v["detectedHoles"]])


HOSTILE = textwrap.dedent("""
    import os, json, socket, subprocess, ctypes
    results = {}
    def probe(name, fn):
        try:
            fn(); results[name] = "ALLOWED"
        except BaseException as e:
            results[name] = type(e).__name__
    probe("read_home", lambda: os.listdir(REAL_HOME))
    probe("read_etc_passwd", lambda: open("/etc/passwd").read())
    probe("write_tmp", lambda: open("/tmp/fc_mcp_escape_test", "w").write("x"))
    probe("proc_parent_environ", lambda: open(f"/proc/{os.getppid()}/environ").read())
    probe("tcp_socket", lambda: socket.create_connection(("1.1.1.1", 80), timeout=2))
    probe("udp_socket", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
    probe("unix_socket", lambda: socket.socket(socket.AF_UNIX))
    probe("subprocess", lambda: subprocess.run(["/bin/true"]))
    probe("fork", lambda: os.fork())
    probe("signal_parent", lambda: os.kill(os.getppid(), 0))
    probe("symlink_out", lambda: os.symlink("/etc/hostname", "link"))
    probe("hardlink_in", lambda: os.link(REAL_HOME + "/.bashrc", "hard"))
    probe("ptrace", lambda: ctypes.CDLL(None).ptrace(0, 0, 0, 0) == 0 or (_ for _ in ()).throw(PermissionError()))
    probe("write_jobdir", lambda: open("scratch.txt", "w").write("ok"))
    with open("probe.json", "w") as f:
        json.dump(results, f)
    doc = App.newDocument("x")
    result_obj = Part.makeBox(1, 1, 1)
""")


class SandboxContainment(unittest.TestCase):
    def test_hostile_script_is_contained(self):
        script = HOSTILE.replace("REAL_HOME", repr(os.path.expanduser("~")))
        r = run_job(script, outputs=("STEP",))
        self.assertTrue(r["build"].get("ok"), r["build"].get("error"))
        with open(os.path.join(r["work"], "probe.json"), encoding="utf-8") as f:
            probe = json.load(f)
        allowed = {k for k, v in probe.items() if v == "ALLOWED"}
        self.assertEqual(allowed, {"write_jobdir"}, probe)
        self.assertFalse(os.path.exists("/tmp/fc_mcp_escape_test"))

    def test_cpu_and_memory_limits(self):
        r = run_job("x = bytearray(6 * 1024 ** 3)\n")  # > 4096 MB address space
        self.assertEqual(r["build"]["error"]["code"], "SCRIPT_ERROR")
        self.assertIn("MemoryError", r["build"]["error"]["message"])


if __name__ == "__main__":
    unittest.main()
