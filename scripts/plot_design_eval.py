"""Figures for the embedded-agent eval (local model) vs the Claude Code MCP-client eval.

    ~/micromamba/envs/freecad-mcp/bin/python scripts/plot_design_eval.py

Reads docs/data/eval_design_qwen.json and docs/data/eval_results.json. Writes
docs/images/eval-design-{light,dark}.svg, eval-design-light.png (for issues), and
qwen-parts.png (iso views of every part the local model produced).
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.image as mpimg  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data"
OUT = ROOT / "docs" / "images"

THEMES = {
    "light": {"surface": "#fcfcfb", "text": "#0b0b0b", "text2": "#52514e", "muted": "#8a8880", "grid": "#e6e5e0",
              "a": "#2a78d6", "b": "#d9822b", "fail": "#c43c3c"},
    "dark": {"surface": "#1a1a19", "text": "#f0efec", "text2": "#c3c2b7", "muted": "#8f8d84", "grid": "#33322f",
             "a": "#3987e5", "b": "#e8964a", "fail": "#e05a5a"},
}
LABELS = {"mounting_plate": "Mounting plate", "bolt_flange": "Bolt flange", "l_bracket": "L-bracket",
          "stepped_shaft": "Stepped shaft", "washer": "Washer", "open_box": "Open tray",
          "hub_with_tapped_holes": "Hub, tapped holes", "hex_standoff": "Hex standoff"}


def load():
    q = json.loads((DATA / "eval_design_qwen.json").read_text())
    c = json.loads((DATA / "eval_results.json").read_text())
    return q, c


def comparison(theme: str, q: dict, c: dict) -> None:
    t = THEMES[theme]
    qr = {r["id"]: r for r in q["results"]}
    cr = {r["id"]: r for r in c["results"]}
    ids = [i for i in LABELS if i in qr or i in cr]
    fig, ax = plt.subplots(figsize=(9.6, 0.62 * len(ids) + 1.9), dpi=100)
    fig.patch.set_facecolor(t["surface"])
    ax.set_facecolor(t["surface"])
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(colors=t["text2"], length=0)
    h = 0.34
    vmax = max([r.get("wallSec") or 0 for r in qr.values()] + [r.get("wallSec") or 0 for r in cr.values()] + [1])
    for i, tid in enumerate(ids):
        y = len(ids) - 1 - i
        for off, rec, col, name in ((h / 2, cr.get(tid), t["a"], "claude"), (-h / 2, qr.get(tid), t["b"], "qwen")):
            if not rec:
                continue
            ok = rec["grade"]["pass"] if name == "claude" else rec["pass"]
            w = rec.get("wallSec") or 0
            ax.barh(y + off, w, height=h * 0.9, color=col if ok else "none", edgecolor=col if ok else t["fail"],
                    hatch=None if ok else "///", lw=1.2)
            extra = "" if name == "claude" else f"  · {rec.get('iterations')} it"
            ax.text(w + vmax * 0.01, y + off, f"{'PASS' if ok else 'FAIL'}  {w:.0f}s{extra}", va="center", fontsize=8.5,
                    color=t["text"] if ok else t["fail"], fontweight="bold" if not ok else "normal")
    ax.set_yticks(range(len(ids)))
    ax.set_yticklabels([LABELS[i] for i in reversed(ids)], fontsize=9.5, color=t["text2"])
    ax.set_xlim(0, vmax * 1.32)
    ax.xaxis.grid(True, color=t["grid"], lw=0.8)
    ax.set_axisbelow(True)
    ax.set_xlabel("wall time per task (s) — hatched = failed hidden spec", color=t["muted"], fontsize=9)
    qs, cs = q["summary"], c["summary"]
    fig.suptitle(f"Hidden-spec pass rate: Claude Code via MCP {cs['passed']}/{cs['tasks']}  ·  "
                 f"local {qs['model']} via embedded pi agent {qs['passedHidden']}/{qs['tasks']}",
                 color=t["text"], fontsize=11.5, x=0.012, y=0.985, ha="left")
    fig.text(0.012, 0.935, f"one run per task · same 8 tasks and grader · Qwen: {qs['workers']} parallel, thinking={qs['thinking']}, "
             f"$0 local · self-reported successes that failed the hidden spec: {qs['falsePositives']}",
             color=t["muted"], fontsize=8.5, ha="left")
    fig.legend(handles=[Patch(color=t["a"], label="Claude Code (default model) as MCP client"),
                        Patch(color=t["b"], label=f"{qs['model']} (vLLM, local) · server-side design agent")],
               loc="lower center", ncol=2, frameon=False, fontsize=8.5, labelcolor=t["text2"], bbox_to_anchor=(0.5, 0.0))
    fig.tight_layout(rect=(0, 0.05, 1, 0.92))
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / f"eval-design-{theme}.svg", facecolor=t["surface"])
    if theme == "light":
        fig.savefig(OUT / "eval-design-light.png", facecolor=t["surface"], dpi=130)
    plt.close(fig)


def parts_montage(q: dict) -> None:
    work = Path(q["summary"]["workDir"])
    work = work if work.is_absolute() else ROOT / work
    tiles = []
    for r in q["results"]:
        png = None
        if r.get("jobId"):
            hits = list((work / r["id"] / "data" / "jobs" / r["jobId"]).rglob("preview.png"))
            png = hits[0] if hits else None
        tiles.append((r, png))
    cols = 4
    rows = (len(tiles) + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(3.2 * cols, 3.0 * rows), dpi=110)
    fig.patch.set_facecolor("#ffffff")
    for ax, (r, png) in zip(axes.flat, tiles):
        ax.axis("off")
        if png:
            img = mpimg.imread(png)
            hgt, wid = img.shape[:2]
            ax.imshow(img[int(hgt * 0.05): hgt // 2, : wid // 2])  # iso view quadrant
        else:
            ax.text(0.5, 0.5, "no part produced", ha="center", va="center", color="#c43c3c", fontsize=10)
        ok = r["pass"]
        ax.set_title(f"{LABELS.get(r['id'], r['id'])} — {'PASS' if ok else 'FAIL'}", fontsize=10,
                     color="#1b7a3a" if ok else "#c43c3c", fontweight="bold")
    for ax in list(axes.flat)[len(tiles):]:
        ax.axis("off")
    fig.suptitle(f"Parts built by local {q['summary']['model']} (embedded pi design agent), iso views from the server's renders",
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(OUT / "qwen-parts.png", facecolor="#ffffff")
    plt.close(fig)


def ablation(theme: str, a: dict, b: dict) -> None:
    """Code Mode (A) vs classic tool calling (B), same model, tasks, grader and locked spec."""
    t = THEMES[theme]
    ar = {r["id"]: r for r in a["results"]}
    br = {r["id"]: r for r in b["results"]}
    ids = [i for i in LABELS if i in ar and i in br]
    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(12.4, 0.6 * len(ids) + 2.2), dpi=100, gridspec_kw={"width_ratios": [1.55, 1]})
    for x in (ax, ax2):
        fig.patch.set_facecolor(t["surface"])
        x.set_facecolor(t["surface"])
        for sp in x.spines.values():
            sp.set_visible(False)
        x.tick_params(colors=t["text2"], length=0)
    h = 0.36
    vmax = max([r["wallSec"] for r in ar.values()] + [r["wallSec"] for r in br.values()] + [1])
    calls = lambda r: sum((r.get("modelCalls") or {}).values())
    for i, tid in enumerate(ids):
        y = len(ids) - 1 - i
        for off, rec, col in ((h / 2, ar[tid], t["b"]), (-h / 2, br[tid], t["neutral"] if "neutral" in t else t["muted"])):
            ok = rec["pass"]
            ax.barh(y + off, rec["wallSec"], height=h * 0.9, color=col if ok else "none", edgecolor=col if ok else t["fail"],
                    hatch=None if ok else "///", lw=1.2)
            ax.text(rec["wallSec"] + vmax * 0.01, y + off, f"{'PASS' if ok else 'FAIL'} {rec['wallSec']:.0f}s · {calls(rec)} calls",
                    va="center", fontsize=8, color=t["text"] if ok else t["fail"])
    ax.set_yticks(range(len(ids)))
    ax.set_yticklabels([LABELS[i] for i in reversed(ids)], fontsize=9.5, color=t["text2"])
    ax.set_xlim(0, vmax * 1.45)
    ax.xaxis.grid(True, color=t["grid"], lw=0.8)
    ax.set_axisbelow(True)
    ax.set_xlabel("wall time per task (s) · calls = model round trips · hatched = failed hidden spec", color=t["muted"], fontsize=8.5)
    fig.legend(handles=[Patch(color=t["b"], label="A · Code Mode (cad_execute: JS + exampleId/fromJob, compact results)"),
                        Patch(color=t["muted"], label="B · classic tools (full scripts in, full results out)")],
               loc="lower center", ncol=2, frameon=False, fontsize=8.5, labelcolor=t["text2"], bbox_to_anchor=(0.5, 0.0))

    sa, sb = a["summary"], b["summary"]
    def med(res, f):
        v = sorted(f(r) for r in res)
        return v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
    rows = [
        ("hidden-spec passes", sa["passedHidden"], sb["passedHidden"], "{:.0f}"),
        ("median wall time (s)", med(a["results"], lambda r: r["wallSec"]), med(b["results"], lambda r: r["wallSec"]), "{:.0f}"),
        ("median model calls", med(a["results"], calls), med(b["results"], calls), "{:.0f}"),
        ("input tokens (k, all tasks)", sa["totalTokens"]["input"] / 1000, sb["totalTokens"]["input"] / 1000, "{:.0f}k"),
        ("output tokens (k, all tasks)", sa["totalTokens"]["output"] / 1000, sb["totalTokens"]["output"] / 1000, "{:.1f}k"),
    ]
    for i, (name, va, vb, fmt) in enumerate(rows):
        y = len(rows) - 1 - i
        top = max(va, vb, 1e-9)
        ax2.barh(y + 0.18, va / top, height=0.32, color=t["b"])
        ax2.barh(y - 0.18, vb / top, height=0.32, color=t["muted"])
        ax2.text(va / top + 0.02, y + 0.18, fmt.format(va), va="center", fontsize=8.5, color=t["text"])
        ax2.text(vb / top + 0.02, y - 0.18, fmt.format(vb), va="center", fontsize=8.5, color=t["text2"])
        ratio = (vb / va) if va else float("nan")
        lbl = f"{name}\nB/A = {ratio:.2f}×" if name != "hidden-spec passes" else name
        ax2.text(-0.03, y, lbl, va="center", ha="right", fontsize=8.5, color=t["text2"])
    ax2.set_xlim(0, 1.35)
    ax2.set_ylim(-0.6, len(rows) - 0.4)
    ax2.set_xticks([])
    ax2.set_yticks([])
    fig.suptitle(f"Ablation on local {sa['model']}: Code Mode vs classic tool calling — same 8 tasks, grader, locked spec and budgets (1 run each)",
                 color=t["text"], fontsize=11, x=0.01, y=0.985, ha="left")
    fig.tight_layout(rect=(0, 0.06, 1, 0.94))
    fig.savefig(OUT / f"eval-ablation-{theme}.svg", facecolor=t["surface"])
    if theme == "light":
        fig.savefig(OUT / "eval-ablation-light.png", facecolor=t["surface"], dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    q, c = load()
    for th in THEMES:
        comparison(th, q, c)
    parts_montage(q)
    print("wrote eval-design-{light,dark}.svg, eval-design-light.png, qwen-parts.png")
    a_path, b_path = DATA / "eval_ablation_codemode.json", DATA / "eval_ablation_classic.json"
    if a_path.exists() and b_path.exists():
        a, b = json.loads(a_path.read_text()), json.loads(b_path.read_text())
        for th in THEMES:
            ablation(th, a, b)
        print("wrote eval-ablation-{light,dark}.svg, eval-ablation-light.png")
