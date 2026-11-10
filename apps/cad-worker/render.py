"""Headless preview rendering (no FreeCADGui / OpenGL / display).

A tiny orthographic renderer on numpy + matplotlib Agg:
  * shaded faces painted far-to-near,
  * a software z-buffer for exact hidden-line removal of B-rep feature edges
    (visible edges solid, hidden edges faint dashed - engineering-drawing style),
  * iso / top / front / right panels at one shared scale, with overall
    dimensions annotated, so an agent can *see* and sanity-check the part.
"""

from __future__ import annotations

import math
import os

VIEWS = {  # name: (elevation deg, azimuth deg) — camera direction like matplotlib's view_init
    "iso": (30.0, -60.0),
    "top": (90.0, -90.0),
    "front": (0.0, -90.0),
    "right": (0.0, 0.0),
    "bottom": (-90.0, -90.0),
    "back": (0.0, 90.0),
    "left": (0.0, 180.0),
}
FACE_RGB = (0.40, 0.58, 0.80)


def _basis(elev: float, azim: float):
    import numpy as np

    e, a = math.radians(elev), math.radians(azim)
    to_cam = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
    up_ref = np.array([0.0, 0.0, 1.0]) if abs(to_cam[2]) < 0.999 else np.array([0.0, 1.0 if to_cam[2] > 0 else -1.0, 0.0])
    right = np.cross(up_ref, to_cam)
    right /= np.linalg.norm(right)
    up = np.cross(to_cam, right)
    if abs(to_cam[2]) >= 0.999 and to_cam[2] > 0:
        # top view: +X right, +Y up
        right, up = np.array([1.0, 0, 0]), np.array([0, 1.0, 0])
    elif abs(to_cam[2]) >= 0.999:
        right, up = np.array([1.0, 0, 0]), np.array([0, -1.0, 0])
    return right, up, to_cam


def _zbuffer(P2, depth, tris, lo, scale, res):
    """Rasterise triangles; returns depth buffer (larger = closer to camera)."""
    import numpy as np

    zb = np.full((res, res), -np.inf)
    px = (P2 - lo) * scale  # pixel coords
    for t in tris:
        (x0, y0), (x1, y1), (x2, y2) = px[t]
        xmin, xmax = int(max(math.floor(min(x0, x1, x2)), 0)), int(min(math.ceil(max(x0, x1, x2)), res - 1))
        ymin, ymax = int(max(math.floor(min(y0, y1, y2)), 0)), int(min(math.ceil(max(y0, y1, y2)), res - 1))
        if xmax < xmin or ymax < ymin:
            continue
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(den) < 1e-12:
            continue
        xs, ys = np.meshgrid(np.arange(xmin, xmax + 1) + 0.5, np.arange(ymin, ymax + 1) + 0.5)
        w0 = ((y1 - y2) * (xs - x2) + (x2 - x1) * (ys - y2)) / den
        w1 = ((y2 - y0) * (xs - x2) + (x0 - x2) * (ys - y2)) / den
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-3) & (w1 >= -1e-3) & (w2 >= -1e-3)
        if not inside.any():
            continue
        z = w0 * depth[t[0]] + w1 * depth[t[1]] + w2 * depth[t[2]]
        sub = zb[ymin:ymax + 1, xmin:xmax + 1]
        np.maximum(sub, np.where(inside, z, -np.inf), out=sub)
    return zb


def _visible(points2, pdepth, zb, lo, scale, res, tol):
    import numpy as np

    px = ((points2 - lo) * scale).astype(int)
    px = np.clip(px, 0, res - 1)
    # Sample a 3x3 neighbourhood max so silhouette edges are not lost to aliasing.
    best = np.full(len(px), -np.inf)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            xx = np.clip(px[:, 0] + dx, 0, res - 1)
            yy = np.clip(px[:, 1] + dy, 0, res - 1)
            best = np.maximum(best, zb[yy, xx])
    # A point is visible if nothing is clearly in front of it.
    return pdepth >= best - tol


def _dim(ax, p0, p1, text, offset, horizontal):
    """Simple dimension line with arrows and label (2D panel coordinates)."""
    if horizontal:
        y = offset
        ax.annotate("", xy=(p0, y), xytext=(p1, y), arrowprops=dict(arrowstyle="<->", color="#b03a2e", lw=0.9))
        ax.text((p0 + p1) / 2, y, text, ha="center", va="bottom", fontsize=8, color="#b03a2e",
                bbox=dict(fc="white", ec="none", pad=0.5))
    else:
        x = offset
        ax.annotate("", xy=(x, p0), xytext=(x, p1), arrowprops=dict(arrowstyle="<->", color="#b03a2e", lw=0.9))
        ax.text(x, (p0 + p1) / 2, text, ha="right", va="center", fontsize=8, color="#b03a2e", rotation=90,
                bbox=dict(fc="white", ec="none", pad=0.5))


def render_preview(shape, path: str, title: str = "", views=("iso", "top", "front", "right"), size_px: int = 1000) -> dict:
    os.environ.setdefault("MPLBACKEND", "Agg")
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib.collections import LineCollection, PolyCollection

    bb = shape.BoundBox
    diag = max(bb.DiagonalLength, 1e-6)
    verts, tris = shape.tessellate(max(diag / 500.0, 0.005))
    V = np.array([[v.x, v.y, v.z] for v in verts], dtype=float).reshape(-1, 3)
    T = np.array(tris, dtype=int).reshape(-1, 3)
    edges3 = []
    for e in shape.Edges:
        try:
            pts = e.discretize(Distance=diag / 300.0)
        except Exception:  # noqa: BLE001
            continue
        if len(pts) > 1:
            edges3.append(np.array([[p.x, p.y, p.z] for p in pts]))

    views = [v for v in views if v in VIEWS] or ["iso"]
    cols = 2 if len(views) > 1 else 1
    rows = math.ceil(len(views) / cols)
    dpi = 100
    fig = plt.figure(figsize=(size_px / dpi, size_px / dpi * rows / cols), dpi=dpi, facecolor="white")

    # Shared scale: largest projected extent over all views.
    projs = {}
    span = 1e-9
    for name in views:
        r, u, c = _basis(*VIEWS[name])
        P2 = np.stack([V @ r, V @ u], axis=1) if len(V) else np.zeros((0, 2))
        D = V @ c if len(V) else np.zeros(0)
        projs[name] = (r, u, c, P2, D)
        if len(P2):
            span = max(span, *(P2.max(axis=0) - P2.min(axis=0)))
    res = 420
    hidden_total = visible_total = 0

    for i, name in enumerate(views):
        r, u, c, P2, D = projs[name]
        ax = fig.add_subplot(rows, cols, i + 1)
        ax.set_aspect("equal")
        ax.axis("off")
        ax.set_title(name, fontsize=10, color="#444", pad=2)
        if not len(P2):
            continue
        lo = P2.min(axis=0)
        hi = P2.max(axis=0)
        mid = (lo + hi) / 2
        half = span / 2 * 1.25
        ax.set_xlim(mid[0] - half, mid[0] + half)
        ax.set_ylim(mid[1] - half, mid[1] + half)

        # Faces, painter's order with Lambert shading (two-sided).
        tri_d = D[T].mean(axis=1)
        order = np.argsort(tri_d)
        n = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        light = 0.75 * c + 0.45 * u + 0.25 * r
        light /= np.linalg.norm(light)
        k = 0.45 + 0.55 * np.abs(n @ light)
        cols_rgb = np.clip(np.outer(k, FACE_RGB), 0, 1)
        polys = P2[T[order]]
        ax.add_collection(PolyCollection(polys, facecolors=cols_rgb[order], edgecolors=cols_rgb[order], linewidths=0.4))

        # Hidden-line removal for B-rep edges.
        scale = (res - 1) / max(hi[0] - lo[0], hi[1] - lo[1], 1e-9)
        zb = _zbuffer(P2, D, T, lo, scale, res)
        tol = max(diag * 2e-3, 2.5 / scale)
        vis_segs, hid_segs = [], []
        for E in edges3:
            e2 = np.stack([E @ r, E @ u], axis=1)
            vis = _visible(e2, E @ c, zb, lo, scale, res, tol)
            for j in range(len(E) - 1):
                seg = e2[j:j + 2]
                (vis_segs if (vis[j] and vis[j + 1]) else hid_segs).append(seg)
        hidden_total += len(hid_segs)
        visible_total += len(vis_segs)
        if hid_segs:
            ax.add_collection(LineCollection(hid_segs, colors="#7b8794", linewidths=0.5, linestyles=(0, (2, 2)), alpha=0.7))
        if vis_segs:
            ax.add_collection(LineCollection(vis_segs, colors="#16202b", linewidths=0.9))

        # Overall dimensions on orthographic views.
        if name in ("top", "front", "right", "bottom", "back", "left"):
            # Exact B-rep extents (not the tessellation, which under-reports curved faces).
            corners = np.array([[x, y, z] for x in (bb.XMin, bb.XMax) for y in (bb.YMin, bb.YMax) for z in (bb.ZMin, bb.ZMax)])
            c2 = np.stack([corners @ r, corners @ u], axis=1)
            elo, ehi = c2.min(axis=0), c2.max(axis=0)
            _dim(ax, elo[0], ehi[0], f"{ehi[0] - elo[0]:.2f}", elo[1] - half * 0.12, True)
            _dim(ax, elo[1], ehi[1], f"{ehi[1] - elo[1]:.2f}", elo[0] - half * 0.08, False)
        else:
            L = span * 0.12
            o = np.array([mid[0] - half * 0.9, mid[1] - half * 0.9])
            for vec, col, lab in (((1, 0, 0), "#c0392b", "X"), ((0, 1, 0), "#27ae60", "Y"), ((0, 0, 1), "#2471a3", "Z")):
                d = np.array([np.dot(vec, r), np.dot(vec, u)]) * L
                ax.annotate("", xy=o + d, xytext=o, arrowprops=dict(arrowstyle="->", color=col, lw=1.2))
                ax.text(*(o + d * 1.25), lab, color=col, fontsize=8, ha="center", va="center")

    caption = f"{title + '   ' if title else ''}bbox {bb.XLength:.2f} x {bb.YLength:.2f} x {bb.ZLength:.2f} mm   " \
              f"volume {shape.Volume:,.1f} mm³   solids {len(shape.Solids)}"
    fig.suptitle(caption, fontsize=10, color="#222", y=0.995)
    fig.subplots_adjust(left=0.01, right=0.99, bottom=0.01, top=0.95, wspace=0.02, hspace=0.08)
    fig.savefig(path, dpi=dpi, facecolor="white")
    plt.close(fig)

    img = plt.imread(path)
    non_bg = float((np.abs(img[..., :3] - 1.0).sum(axis=2) > 0.06).mean())
    return {"rendered": True, "views": list(views), "nonBlankFraction": round(non_bg, 4),
            "widthPx": int(img.shape[1]), "heightPx": int(img.shape[0]), "triangles": int(len(T)),
            "visibleEdgeSegments": visible_total, "hiddenEdgeSegments": hidden_total}
