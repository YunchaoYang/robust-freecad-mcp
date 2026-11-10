"""Artifact export with deterministic file names."""

from __future__ import annotations

import os

FILE_NAMES = {"FCStd": "model.FCStd", "STEP": "model.step", "STL": "model.stl"}


def export_all(doc, result_obj, formats: list[str], out_dir: str) -> list[dict]:
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for fmt in formats:
        if fmt not in FILE_NAMES:  # e.g. PNG previews are rendered in the verify phase
            continue
        path = os.path.join(out_dir, FILE_NAMES[fmt])
        entry = {"format": fmt, "name": FILE_NAMES[fmt], "ok": False}
        try:
            if fmt == "FCStd":
                doc.saveAs(path)
            elif fmt == "STEP":
                result_obj.Shape.exportStep(path)
            elif fmt == "STL":
                import Mesh
                import MeshPart

                mesh = MeshPart.meshFromShape(Shape=result_obj.Shape, LinearDeflection=0.05, AngularDeflection=0.2, Relative=False)
                mesh.write(path)
            size = os.path.getsize(path) if os.path.isfile(path) else 0
            entry["sizeBytes"] = size
            entry["ok"] = size > 0
            if size == 0:
                entry["error"] = "export produced no data"
        except Exception as exc:  # noqa: BLE001 - surface any exporter failure
            entry["error"] = f"{type(exc).__name__}: {exc}"
        results.append(entry)
    return results
