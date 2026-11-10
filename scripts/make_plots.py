"""Render README comparison figures (light + dark SVG) from docs/data/*.json.

    ~/micromamba/envs/freecad-mcp/bin/python scripts/make_plots.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data"
OUT = ROOT / "docs" / "images"

THEMES = {
    "light": {"surface": "#fcfcfb", "text": "#0b0b0b", "text2": "#52514e", "muted": "#8a8880", "grid": "#e6e5e0",
              "accent": "#2a78d6", "neutral": "#b9b7ae"},
    "dark": {"surface": "#1a1a19", "text": "#f0efec", "text2": "#c3c2b7", "muted": "#8f8d84", "grid": "#33322f",
             "accent": "#3987e5", "neutral": "#5d5c57"},
}


def _style(fig, ax, t):
    fig.patch.set_facecolor(t["surface"])
    ax.set_facecolor(t["surface"])
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(colors=t["text2"], length=0)


def tokens_chart(theme: str) -> None:
    t = THEMES[theme]
    d = json.loads((DATA / "tool_tokens.json").read_text())["servers"]
    rows = sorted(d.items(), key=lambda kv: kv[1]["approxTokens"])
    names = [f"{k}  ({v['tools']} tools)" for k, v in rows]
    vals = [v["approxTokens"] for _, v in rows]
    ours = [k == "this server" for k, _ in rows]
    fig, ax = plt.subplots(figsize=(9.6, 0.42 * len(rows) + 1.3), dpi=100)
    _style(fig, ax, t)
    y = range(len(rows))
    ax.barh(list(y), vals, height=0.5, color=[t["accent"] if o else t["neutral"] for o in ours])
    vmax = max(vals)
    for i, (v, o) in enumerate(zip(vals, ours)):
        ax.text(v + vmax * 0.01, i, f"{v:,}", va="center", ha="left", fontsize=9,
                color=t["text"] if o else t["text2"], fontweight="bold" if o else "normal")
    ax.set_yticks(list(y))
    ax.set_yticklabels(names, fontsize=9)
    for lbl, o in zip(ax.get_yticklabels(), ours):
        lbl.set_color(t["text"] if o else t["text2"])
        if o:
            lbl.set_fontweight("bold")
    ax.set_xlim(0, vmax * 1.12)
    ax.xaxis.grid(True, color=t["grid"], lw=0.8)
    ax.set_axisbelow(True)
    ax.set_xlabel("≈ tokens loaded before the first call (tool names + descriptions + input schemas, bytes ÷ 4)",
                  fontsize=8.5, color=t["muted"])
    fig.suptitle("Upfront context cost of CAD MCP servers", x=0.01, ha="left", fontsize=12.5, color=t["text"], fontweight="bold")
    fig.text(0.01, 0.905 if len(rows) > 10 else 0.88, "Our tool definitions are measured live; the others are reconstructed statically from source.",
             fontsize=8.5, color=t["text2"], ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.9))
    fig.savefig(OUT / f"tool-tokens-{theme}.svg", facecolor=t["surface"])
    if os.environ.get("PREVIEW_DIR"):
        fig.savefig(Path(os.environ["PREVIEW_DIR"]) / f"tool-tokens-{theme}.png", facecolor=t["surface"])
    plt.close(fig)


def feature_matrix(theme: str) -> None:
    t = THEMES[theme]
    d = json.loads((DATA / "feature_matrix.json").read_text())
    servers, feats, kernels = d["servers"], d["features"], d["kernels"]
    nf, ns = len(feats), len(servers)
    fig, ax = plt.subplots(figsize=(4.4 + 1.3 * ns, 0.5 * nf + 2.0), dpi=100)
    _style(fig, ax, t)
    ax.set_xlim(-0.6, ns - 0.4)
    ax.set_ylim(nf + 0.4, -1.5)
    ax.set_xticks([])
    ax.set_yticks(range(nf))
    ax.set_yticklabels([f["name"] for f in feats], fontsize=9, color=t["text"])
    for j, s_ in enumerate(servers):
        ours = j == 0
        short = s_.split("/")[-1] if "/" in s_ else s_
        owner = s_.split("/")[0] if "/" in s_ else ""
        ax.text(j, -0.75, short, ha="center", va="bottom", fontsize=7.8, color=t["text"] if ours else t["text2"],
                fontweight="bold" if ours else "normal")
        ax.text(j, -0.45, f"{owner + ' · ' if owner else ''}{kernels[j]}", ha="center", va="bottom", fontsize=6.6, color=t["muted"])
    ax.axvspan(-0.45, 0.45, color=t["accent"], alpha=0.08, lw=0)
    for i in range(nf - 1):
        ax.axhline(i + 0.5, color=t["grid"], lw=0.6)

    def mark(x, y, v, col, size=11):
        if v == "yes":
            ax.plot([x], [y], "o", ms=size, color=col, mec=col, clip_on=False)
        elif v == "partial":
            ax.plot([x], [y], "o", ms=size, fillstyle="left", color=col, mec=col, mfc=col, mfcalt=t["surface"], mew=1.3, clip_on=False)
        elif v == "no":
            ax.plot([x], [y], "o", ms=size, mfc=t["surface"], mec=t["muted"], mew=1.1, clip_on=False)
        else:
            ax.text(x, y, "n/a", ha="center", va="center", fontsize=7.5, color=t["muted"])

    for i, f in enumerate(feats):
        for j, v in enumerate(f["values"]):
            mark(j, i, v, t["accent"] if j == 0 else t["text2"])
    leg_y = nf - 0.05 + 0.3
    for k, (lab, kind) in enumerate((("supported", "yes"), ("partial / limited", "partial"), ("not found in docs or source", "no"))):
        x = 0.0 + k * 1.9
        mark(x, leg_y, kind, t["text2"], size=8)
        ax.text(x + 0.18, leg_y, lab, va="center", fontsize=8.5, color=t["text2"], clip_on=False)
    fig.suptitle("CAD MCP servers: capability comparison", x=0.01, ha="left", fontsize=12.5, color=t["text"], fontweight="bold")
    fig.text(0.01, 0.012, f"As of {d['asOf']}; from each project's README, docs and tool source (not executed). Partial = GUI-only, test-only or language-level.",
             fontsize=7.8, color=t["muted"], ha="left")
    fig.tight_layout(rect=(0, 0.03, 1, 0.96))
    fig.savefig(OUT / f"feature-matrix-{theme}.svg", facecolor=t["surface"])
    if os.environ.get("PREVIEW_DIR"):
        fig.savefig(Path(os.environ["PREVIEW_DIR"]) / f"feature-matrix-{theme}.png", facecolor=t["surface"])
    plt.close(fig)


def eval_chart(theme: str) -> None:
    path = DATA / "eval_results.json"
    if not path.exists():
        return
    t = THEMES[theme]
    d = json.loads(path.read_text())
    res = d["results"]
    fig, ax = plt.subplots(figsize=(9.6, 0.42 * len(res) + 1.4), dpi=100)
    _style(fig, ax, t)
    for i, r in enumerate(res):
        ok = r["grade"]["pass"]
        turns = r.get("turns") or 0
        ax.barh(i, turns, height=0.5, color=t["accent"] if ok else t["neutral"])
        ax.text(turns + 0.2, i, f"{'✓ pass' if ok else '✗ fail'} · {turns} turns · {r.get('wallSec', 0):.0f}s",
                va="center", fontsize=9, color=t["text"] if ok else t["text2"])
    ax.set_yticks(range(len(res)))
    ax.set_yticklabels([r["id"].replace("_", " ") for r in res], fontsize=9, color=t["text"])
    ax.invert_yaxis()
    ax.set_xlim(0, max((r.get("turns") or 0) for r in res) * 1.6 + 1)
    ax.xaxis.grid(True, color=t["grid"], lw=0.8)
    ax.set_axisbelow(True)
    ax.set_xlabel("agent turns to a graded result", fontsize=8.5, color=t["muted"])
    s = d["summary"]
    fig.suptitle(f"NL→CAD benchmark: {s['passed']}/{s['tasks']} tasks pass hidden geometric specs", x=0.01, ha="left",
                 fontsize=12.5, color=t["text"], fontweight="bold")
    fig.text(0.01, 0.88, f"Claude Code ({s['model']}) using only this server's MCP tools, {s['date']}. Graded on the exported STEP in a fresh sandboxed process.",
             fontsize=8.5, color=t["text2"], ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.87))
    fig.savefig(OUT / f"eval-{theme}.svg", facecolor=t["surface"])
    if os.environ.get("PREVIEW_DIR"):
        fig.savefig(Path(os.environ["PREVIEW_DIR"]) / f"eval-{theme}.png", facecolor=t["surface"])
    plt.close(fig)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for th in THEMES:
        tokens_chart(th)
        feature_matrix(th)
        eval_chart(th)
    print("wrote", sorted(p.name for p in OUT.glob("*.svg")))
