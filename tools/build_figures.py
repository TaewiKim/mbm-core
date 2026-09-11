""" figure generator (Python / matplotlib -> SVG + PDF + PNG).

Generates main figures (Fig.1-4) and supplement figures (S1-S15) from committed result
files under results/eval, and records every output (with SHA-256) in
results/eval/figure_manifest.json. No numeric value is hand-typed into data figures
(Fig.3/4, S*): they read result JSON.

Usage:
  python tools/build_figures.py --main
  python tools/build_figures.py --supplement
  python tools/build_figures.py --figure fig3
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import matplotlib as mpl

mpl.use("Agg", force=True)
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

ROOT = Path(__file__).resolve().parents[1]
FIG_DIR = ROOT / "figures"
SUPP_DIR = FIG_DIR / "supp"
MANIFEST = ROOT / "results" / "eval" / "figure_manifest.json"

# Colorblind-safe Okabe--Ito palette, applied consistently across every figure:
# blue = treatment / MBM-Core, vermillion = baseline / failure, bluish-green = allow / gain.
PALETTE = {
    "ink": "#1a1a1a",
    "muted": "#6b7280",
    "accent": "#0072b2",   # Okabe-Ito blue   -- MBM-Core / treatment
    "accent_dk": "#03406a",
    "good": "#009e73",     # Okabe-Ito green  -- allow / gain
    "bad": "#d55e00",      # Okabe-Ito vermillion -- deny / failure / baseline
    "grid": "#d9dde3",
    "pending": "#9aa0a6",
    "bg": "#ffffff",
    "panel": "#f7f8fa",
    "accent_fill": "#e2eef7",  # light blue fill
    "good_fill": "#e1f3ec",    # light green fill
    "bad_fill": "#fbeadd",     # light vermillion fill
}

# convenience aliases for diagram renderers
INK = PALETTE["ink"]; MUTED = PALETTE["muted"]; ACCENT = PALETTE["accent"]
ACCENT_DK = PALETTE["accent_dk"]; GOOD = PALETTE["good"]; BAD = PALETTE["bad"]
GRID = PALETTE["grid"]; PENDING = PALETTE["pending"]


def configure_style():
    mpl.rcParams.update({
        "figure.dpi": 160,
        "savefig.dpi": 320,
        "font.family": "DejaVu Sans",
        "font.size": 8.0,
        "axes.labelsize": 8.0,
        "axes.titlesize": 9.5,
        "xtick.labelsize": 7.2,
        "ytick.labelsize": 7.2,
        "axes.linewidth": 0.75,
        "axes.edgecolor": PALETTE["ink"],
        "text.color": PALETTE["ink"],
        "svg.fonttype": "none",
        "pdf.fonttype": 42,
        "svg.hashsalt": "mbm-core",  # fixed salt => deterministic SVG element ids => stable hashes
    })


def load_json(rel_or_path):
    p = Path(rel_or_path)
    if not p.is_absolute():
        p = ROOT / rel_or_path
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def sha256_file(path: Path):
    if not path.exists():
        return None
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path):
    return path.resolve().relative_to(ROOT).as_posix()


# ---------- helpers for conceptual diagrams ----------
def box(ax, x, y, w, h, *, fc="white", ec=PALETTE["ink"], lw=1.0, rad=0.02, z=2):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle=f"round,pad=0,rounding_size={rad}",
        linewidth=lw, edgecolor=ec, facecolor=fc, zorder=z, mutation_aspect=1))


def arrow(ax, x1, y1, x2, y2, *, color=PALETTE["ink"], lw=1.6, z=3):
    ax.add_patch(FancyArrowPatch(
        (x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=12,
        linewidth=lw, color=color, zorder=z, shrinkA=0, shrinkB=0))


def t(ax, x, y, s, *, size=8, ha="left", va="center", color=PALETTE["ink"], weight="normal", style="normal"):
    ax.text(x, y, s, fontsize=size, ha=ha, va=va, color=color, fontweight=weight, fontstyle=style, zorder=4)


def blank_ax(fig, rect=(0, 0, 1, 1)):
    ax = fig.add_axes(rect)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")
    return ax


# ---------- Fig 1: communication-memory mismatch ----------
# Fig.1 is a hand-authored vector schematic (publication-grade diagram, beyond matplotlib's
# diagramming quality). Its source of truth is figures/src/fig1_workflow_mismatch.svg;
# it is integrated as a static asset (see STATIC_MAIN / build_static) and converted to PDF/PNG with
# rsvg-convert. The committed svg/pdf/png are hashed into the manifest like every other figure.


# ---------- Fig 2: message-bound gate ----------
# Fig.2 is a hand-authored vector schematic (see STATIC_MAIN). Source of truth:
# figures/src/fig2_message_bound_gate.svg; converted to PDF/PNG with rsvg-convert
# and hashed into the manifest. It mirrors Algorithm 1 (the seven conjunctive checks and their
# reason codes) and the runtime evaluateMemoryGate().


# ---------- Fig 3: forest of paired FFCR deltas ----------
def fig3():
    data = load_json("results/eval/best-baseline-analysis.json") or load_json("results/eval/sota-best-baseline-analysis.json")
    rows = (data["rows"] + [data["aggregate"]]) if data else []
    fig = plt.figure(figsize=(7.0, 3.2))
    ax = fig.add_axes((0.34, 0.17, 0.62, 0.80))
    n = len(rows)
    ys = list(range(n))[::-1]  # top row first
    ax.set_xlim(-0.1, 1.22)
    ax.set_ylim(-0.7, n - 0.3)
    ax.axvline(0, color=PALETTE["ink"], lw=1.1, zorder=1)
    for xt in [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]:
        ax.axvline(xt, color=PALETTE["grid"], lw=0.6, zorder=0)
    labels = []
    for row, y in zip(rows, ys):
        is_agg = row.get("id") == "aggregate"
        labels.append((y, row))
        if row.get("status") == "ready":
            col = PALETTE["accent_dk"] if is_agg else PALETTE["accent"]
            lo, hi = row["ci95"]
            d = row["ffcr_delta"]
            ax.plot([lo, hi], [y, y], color=col, lw=2.0, zorder=3)
            ax.plot([lo, lo], [y - 0.12, y + 0.12], color=col, lw=2.0, zorder=3)
            ax.plot([hi, hi], [y - 0.12, y + 0.12], color=col, lw=2.0, zorder=3)
            ax.scatter([d], [y], s=(46 if is_agg else 32), color=col, zorder=4)
            star = " ★" if row.get("significant_after_correction") else ""
            ax.text(hi + 0.015, y, f"{d:.2f}{star}", fontsize=7.6, va="center", color=col, fontweight="bold")
        else:
            ax.text(0.4, y, "data pending (live run not yet complete)", fontsize=7.4,
                    va="center", ha="center", color=PALETTE["pending"], fontstyle="italic")
    ax.set_yticks([y for y, _ in labels])
    ax.set_yticklabels([])
    for y, row in labels:
        is_agg = row.get("id") == "aggregate"
        ax.text(-0.155 / 0.62 * (0.9 - -0.1) - 0.1, y + 0.14,
                row.get("label", row.get("id")), fontsize=8.0,
                fontweight=("bold" if is_agg else "normal"), va="center", ha="left",
                transform=ax.get_yaxis_transform(), clip_on=False)
        if row.get("status") == "ready":
            ax.text(-0.155 / 0.62 * (0.9 - -0.1) - 0.1, y - 0.22,
                    f"n={row['paired_n']} · {row.get('best_baseline_label','')}",
                    fontsize=6.0, color=PALETTE["muted"], va="center", ha="left",
                    transform=ax.get_yaxis_transform(), clip_on=False)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.tick_params(left=False)
    ax.set_xlabel("Memory-selection accuracy delta  (MBM-Core - best evaluated baseline)", fontsize=8.0)
    fig.text(0.34, 0.02, "★ = statistically significant after correction (95% CI lower bound > 0)",
             fontsize=7.2, color=PALETTE["muted"])
    return fig, "fig3_best_evaluated_baseline_delta", "Best Evaluated Baseline Result: MBM-Core vs Baseline"


# ---------- Fig 4: robustness (3 panels) ----------
def fig4():
    neg = load_json("results/eval/negative-controls-analysis.json")
    stress = load_json("results/eval/stress-scaling-analysis.json")
    cost = load_json("results/eval/cost-pareto-analysis.json")
    split = load_json("results/eval/ablation-family-split-analysis.json")
    # Single-column layout, lettered in reading order top-to-bottom: panel A (long-horizon stress,
    # the axB variable) is the hero on top (largest, emphasized); panel B (no-op controls, the axA
    # variable) sits beneath it full-width; C (cost Pareto) and D (single-check ablation) form an
    # equally sized bottom pair. Variable names (axA/axB) are historical and do not match the
    # displayed letters. Sized for IEEE column width so labels stay legible at \linewidth.
    fig = plt.figure(figsize=(3.5, 4.2))
    axB = fig.add_axes((0.17, 0.760, 0.80, 0.190))   # panel A (hero): top, largest
    axA = fig.add_axes((0.30, 0.450, 0.66, 0.135))   # panel B: full-width, beneath the hero
    axC = fig.add_axes((0.165, 0.110, 0.32, 0.160))  # bottom-left
    axD = fig.add_axes((0.640, 0.110, 0.32, 0.160))  # bottom-right: SAME size as C

    # Panel A
    axA.set_title("B  negative / no-op controls", fontsize=8.5, loc="left")
    if neg and neg.get("controls"):
        ctrls = neg["controls"]
        names = [("MBM-Core" if c.get("id") == "acmcp-core" else c["label"].replace("C5-", "")) for c in ctrls]
        vals = [c.get("ffcr", 0) for c in ctrls]

        def _col(c):
            if c.get("id") == "acmcp-core":
                return PALETTE["good"]
            return PALETTE["bad"] if c.get("type") == "binding_corruption" else PALETTE["muted"]

        cols = [_col(c) for c in ctrls]
        # hatch the single-check ablations to mark them as model-compensated
        hatches = ["//" if c.get("type") == "single_check_ablation" else "" for c in ctrls]
        yy = range(len(ctrls))
        bars = axA.barh(list(yy), vals, color=cols, height=0.62)
        for bar, h in zip(bars, hatches):
            if h:
                bar.set_hatch(h)
                bar.set_edgecolor("white")
        axA.set_yticks(list(yy))
        axA.set_yticklabels(names, fontsize=7.0)
        axA.invert_yaxis()
        axA.set_xlim(0, 1)
        axA.set_xlabel("FFCR", fontsize=8)
    else:
        _pending(axA, "pending (run E9)")

    # Panel B
    axB.set_title("A  long-horizon stress", fontsize=9.5, loc="left", fontweight="bold")
    if stress and stress.get("series"):
        xs = stress.get("x", [])
        colmap = {"MBM-Core": PALETTE["accent"], "best evaluated baseline": PALETTE["bad"],
                  "C4+all-static-filters": PALETTE["muted"], "C4 (scoped memory)": PALETTE["bad"]}
        for s in stress["series"]:
            axB.plot(xs, s["ffcr"], marker="o", ms=4, lw=2.0,
                     color=colmap.get(s["label"], PALETTE["ink"]), label=s["label"])
        axB.set_ylim(0, 1.05)
        axB.set_xlabel(stress.get("x_label", "workflow length"), fontsize=8.0)
        axB.set_ylabel("FFCR", fontsize=8.5)
        axB.legend(fontsize=6.4, frameon=False, loc="center right", handlelength=1.4,
                   borderaxespad=0.2)
    else:
        _pending(axB, "pending (run E10)")

    # Panel C
    axC.set_title("C  cost vs. FFCR", fontsize=8.5, loc="left")
    if cost and cost.get("points"):
        max_tok = max(p["cost"] for p in cost["points"])
        axC.set_xlim(0, max_tok * 1.30)
        axC.set_ylim(-0.05, 1.18)
        # short labels so annotations fit the narrow single-column panel
        short = {"acmcp-core": "MBM-Core", "C4+all-static-filters": "C4+filters",
                 "C4 (scoped memory)": "C4"}
        for p in cost["points"]:
            is_core = p.get("id") == "acmcp-core"
            c = PALETTE["good"] if is_core else PALETTE["ink"]
            axC.scatter([p["cost"]], [p["ffcr"]], s=(40 if is_core else 26), color=c)
            right_half = p["cost"] > max_tok * 0.5
            axC.annotate(short.get(p.get("id"), short.get(p["label"], p["label"])),
                         (p["cost"], p["ffcr"]), fontsize=6.0, color=c,
                         xytext=(-4 if right_half else 4, 4), textcoords="offset points",
                         ha="right" if right_half else "left")
        axC.set_xlabel(cost.get("x_label", "prompt tokens"), fontsize=7.5)
        axC.set_ylabel("FFCR", fontsize=7.5)
    else:
        _pending(axC, "pending (run E12)")

    # Panel D: single-check ablation as a 2x3 dissociation matrix (rows = ablations, cols = failure-
    # class families). A cell is green when the gate still protects (100%) and red when protection is
    # lost (0%). The row labels are the key, so the narrow panel needs no floating legend and carries
    # no overlapping text -- no-policy breaks only policy/status-cued families, no-provenance only the
    # provenance-cued family, and neither breaks the run/task/reader-bound families.
    axD.set_title("D  ablation", fontsize=8.5, loc="left")
    if split and split.get("groups"):
        import numpy as np
        from matplotlib.colors import ListedColormap
        order = ["policy_status_cued", "provenance_cued", "other_bound"]
        groups = [(g, split["groups"][g]) for g in order if g in split["groups"]]
        col_lab = {"policy_status_cued": "policy/\nstatus", "provenance_cued": "prov.",
                   "other_bound": "other\n(bound)"}
        collabels = [f"{col_lab.get(k, k)}\n(n={v['n_families']})" for k, v in groups]
        rows = ["no-\npolicy", "no-\nprov."]
        mat = np.array([
            [v["gate_protection"]["no_policy"] for _, v in groups],
            [v["gate_protection"]["no_provenance"] for _, v in groups],
        ])
        axD.imshow(mat, cmap=ListedColormap([PALETTE["bad"], PALETTE["good"]]),
                   vmin=0, vmax=1, aspect="auto")
        for r in range(mat.shape[0]):
            for c in range(mat.shape[1]):
                axD.text(c, r, "100%" if mat[r, c] >= 0.5 else "0%", ha="center", va="center",
                         color="white", fontsize=6.0, fontweight="bold")
        axD.set_xticks(range(len(groups)))
        axD.set_xticklabels(collabels, fontsize=5.8)
        axD.set_yticks(range(len(rows)))
        axD.set_yticklabels(rows, fontsize=6.0)
        axD.tick_params(length=0)
        for sp in axD.spines.values():
            sp.set_visible(False)
    else:
        _pending(axD, "pending (run E9 + ablation split)")

    for ax in (axA, axB, axC):
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(labelsize=6.8)
    return fig, "fig4_robustness_summary", "Robustness and Mechanism Validation"


# ---------- Fig 5: per-scenario-family effect (controlled C4 vs C5) ----------
_FAMILY_SHORT = {
    "twin_run_shared_memory_contamination": "twin-run",
    "pause_resume_deferred_constraint": "pause/resume",
    "crash_retry_with_superseded_policy": "superseded-policy",
    "branch_merge_with_conflicting_memories": "branch/merge",
    "artifact_dependent_handoff": "artifact-handoff",
    "private_memory_summary": "private-summary",
    "long_horizon_drift": "long-horizon-drift",
    "audit_reconstruction": "audit-reconstruction",
    "graph_only_sibling_branch_provenance": "sibling-branch",
}


def fig5():
    import numpy as np
    raw = load_json("results/coupled-memory-phase6-live-main40-r3-combined-2models.json")
    fig = plt.figure(figsize=(3.45, 3.05))
    ax = fig.add_axes((0.40, 0.12, 0.56, 0.81))
    if raw:
        fams = sorted({c["scenario_type"] for c in raw["cases"]})

        def ffcr(fam, cond):
            it = [c for c in raw["cases"] if c["scenario_type"] == fam
                  and c["condition"] == cond and not c.get("api_error")]
            return sum(1 for c in it if c.get("model_success")) / len(it) if it else 0

        # order families by the size of the C5-C4 gain (largest at top)
        fams = sorted(fams, key=lambda f: ffcr(f, "C5") - ffcr(f, "C4"))
        y = np.arange(len(fams))
        ax.barh(y + 0.20, [ffcr(f, "C4") for f in fams], height=0.38,
                color=PALETTE["bad"], label="C4 (scoped memory)")
        ax.barh(y - 0.20, [ffcr(f, "C5") for f in fams], height=0.38,
                color=PALETTE["accent"], label="C5 / MBM-Core")
        ax.set_yticks(y)
        ax.set_yticklabels([_FAMILY_SHORT.get(f, f) for f in fams], fontsize=6.6)
        ax.set_xlim(0, 1.0)
        ax.set_xlabel("Memory-selection accuracy", fontsize=7.5)
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(labelsize=6.6)
        ax.legend(fontsize=6.2, frameon=False, ncol=2, loc="lower center",
                  bbox_to_anchor=(0.5, 1.0), borderaxespad=0.0)
    else:
        _pending(ax, "pending (run E1)")
    return fig, "fig5_per_scenario_effect", "Per-Scenario-Family Effect"


# ---------- Fig 6: adversarial separation (content-cued rescue vs content-blind holdout) ----------
def _ffcr_ordered(raw):
    ff = _ffcr_by_condition(raw)
    order = [k for k in ["C4", "C4+run-filter", "C4+task-filter", "C4+status-filter",
                         "C4+reader-filter", "C4+policy-filter", "C4+all-static-filters",
                         "C4+oracle-retriever", "C5"] if k in ff]
    labels = [("MBM-Core (C5)" if k == "C5" else k) for k in order]
    vals = [ff[k] for k in order]
    cols = [PALETTE["good"] if k == "C5" else PALETTE["bad"] for k in order]
    return labels, vals, cols


def fig6():
    import numpy as np
    e5 = load_json("results/eval/e5-strong-baseline-combined.json")
    e7 = load_json("results/eval/e7-holdout-combined.json")
    # single-column stacked layout (A: 9 bars on top, B: 4 bars below) sized for IEEE column width
    fig = plt.figure(figsize=(3.45, 3.0))
    axA = fig.add_axes((0.46, 0.57, 0.50, 0.38))
    axB = fig.add_axes((0.46, 0.11, 0.50, 0.20))

    # value labels are placed just past each bar end on a padded x-axis so that a 1.00 bar
    # (full width) never clips its own label against the right spine.
    def _bar_panel(ax, raw, pending_msg):
        labels, vals, cols = _ffcr_ordered(raw)
        y = np.arange(len(labels))
        ax.barh(y, vals, color=cols, height=0.66)
        ax.set_yticks(y)
        ax.set_yticklabels(labels, fontsize=6.6)
        ax.invert_yaxis()
        ax.set_xlim(0, 1.15)
        ax.set_xticks([0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
        ax.set_xlabel("FFCR", fontsize=8)
        for yy, v in zip(y, vals):
            ax.text(v + 0.025, yy, f"{v:.2f}", va="center", ha="left",
                    fontsize=6.6, color=PALETTE["ink"])

    axA.set_title("A  strong-baseline rescue", fontsize=8, loc="left")
    if e5:
        _bar_panel(axA, e5, None)
    else:
        _pending(axA, "pending (run E5)")

    axB.set_title("B  blinded holdout", fontsize=8, loc="left")
    if e7:
        _bar_panel(axB, e7, None)
    else:
        _pending(axB, "pending (run E7)")

    for ax in (axA, axB):
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(labelsize=6.8)
    return fig, "fig6_adversarial_separation", "Adversarial Separation: Rescue vs Holdout"


# ---------- Fig 7: long-running multi-agent workflow (E18) -- the title-claim result ----------
def fig7():
    import numpy as np
    d = load_json("results/eval/e18-longrun-analysis.json")
    # Panel C: the earlier live-LangGraph end-to-end ACCURACY number was an oracle-fallback artifact
    # (review M1) and is still NOT plotted. Instead we plot the LangGraph injection PoC's DETERMINISTIC
    # gate decisions (no API): the real-framework SECURITY outcome (forged-field plants admitted).
    e16 = load_json("results/eval/e16-locomo-analysis.json")
    lg = load_json("results/eval/poc-langgraph-injection.json")
    # 2x2 external-validity panel: synthetic (A,B), real framework (C), scope boundary (D).
    fig = plt.figure(figsize=(3.45, 3.25))
    axA = fig.add_axes((0.135, 0.575, 0.34, 0.275))
    axB = fig.add_axes((0.635, 0.575, 0.34, 0.275))
    axC = fig.add_axes((0.135, 0.095, 0.34, 0.275))
    axD = fig.add_axes((0.635, 0.095, 0.34, 0.275))
    if not d:
        for ax in (axA, axB, axC, axD):
            _pending(ax, "pending (run E18)")
        return fig, "fig7_longrun_multiagent", "Long-Running Multi-Agent Workflows"

    MODEL_SHORT = {"gpt-5.4-nano": "nano", "gpt-5.4-mini": "mini", "gpt-5-nano": "nano", "gpt-5-mini": "mini"}
    bm = d.get("by_model", {})
    models = [m for m in ["gpt-5.4-nano", "gpt-5.4-mini", "gpt-5-nano", "gpt-5-mini"] if m in bm] or list(bm.keys())
    labels = [MODEL_SHORT.get(m, m) for m in models] + ["all"]
    x = np.arange(len(labels)); w = 0.38

    def panel(ax, c4key, c5key, aggC4, aggC5, title, c5color):
        c4 = [bm[m][c4key] for m in models] + [aggC4]
        c5 = [bm[m][c5key] for m in models] + [aggC5]
        ax.bar(x - w / 2, c4, w, color=PALETTE["bad"])
        ax.bar(x + w / 2, c5, w, color=c5color)
        # Value labels: when the paired C4/C5 bars are at (near-)equal height their labels would
        # collide horizontally (e.g. "1.001.00"), so push them apart on collision and shrink the font.
        for i in range(len(labels)):
            h4, h5 = c4[i], c5[i]
            dx = 0.11 if abs(h4 - h5) < 0.06 else 0.0
            ax.text(x[i] - w / 2 - dx, h4 + 0.02, f"{h4:.2f}", ha="center", va="bottom",
                    fontsize=4.6, color=PALETTE["ink"])
            ax.text(x[i] + w / 2 + dx, h5 + 0.02, f"{h5:.2f}", ha="center", va="bottom",
                    fontsize=4.6, color=PALETTE["ink"])
        ax.set_xticks(x); ax.set_xticklabels(labels, fontsize=6.2)
        ax.set_ylim(0, 1.34); ax.set_yticks([0, 0.5, 1.0])
        ax.set_title(title, fontsize=7.4, loc="left")
        ax.tick_params(labelsize=6.2)
        ax.spines[["top", "right"]].set_visible(False)

    def pair(ax, vals, xlabels, colors, title, sub):
        xs = np.arange(len(vals))
        bars = ax.bar(xs, vals, 0.6, color=colors)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v + 0.02, f"{v:.2f}",
                    ha="center", va="bottom", fontsize=5.4, color=PALETTE["ink"])
        ax.set_xticks(xs); ax.set_xticklabels(xlabels, fontsize=6.2)
        # Extra top headroom so the sub-annotation clears a full-height bar's value label
        # (panel C "forged-field plants admitted" otherwise overlaps the "1.00" label).
        ax.set_ylim(0, 1.34); ax.set_yticks([0, 0.5, 1.0])
        ax.set_title(title, fontsize=7.4, loc="left")
        ax.tick_params(labelsize=6.2)
        ax.text(0.03, 0.99, sub, transform=ax.transAxes, ha="left", va="top",
                fontsize=4.8, color=PALETTE["muted"])
        ax.spines[["top", "right"]].set_visible(False)

    panel(axA, "c4_success", "c5_success", d["c4_success"], d["c5_success"],
          "A  synthetic E2E success", PALETTE["good"])
    panel(axB, "c4_contamination_rate", "c5_contamination_rate",
          d["c4_contamination_rate"], d["c5_contamination_rate"],
          "B  contamination rate", PALETTE["accent"])
    # Panel C: real LangGraph security outcome (deterministic, no API) -- fraction of forged-field plants
    # the executor acts on; the ungated graph admits both plants (emits the attacker value), the gated
    # graph denies both (reachability + attestation). Replaces the withdrawn oracle-fallback accuracy bar.
    if lg:
        plants = ["mem-trap", "mem-trap-ancestor"]
        ungC = sum(1 for p in plants if p in lg["ungated"]["admitted"]) / len(plants)
        gatC = sum(1 for p in plants if p in lg["gated"]["admitted"]) / len(plants)
        pair(axC, [ungC, gatC], ["ungated", "gated"], [PALETTE["bad"], PALETTE["good"]],
             "C  real LangGraph (no API)", "forged-field plants admitted")
    else:
        axC.set_title("C  real LangGraph (no API)", fontsize=7.4, loc="left")
        _pending(axC, "pending (run poc:langgraph)")
    if e16:
        o = e16["overall"]
        pair(axD, [o["native_acc"], o["mbm_acc"]], ["native", "+MBM"],
             [PALETTE["muted"], PALETTE["accent"]],
             "D  LoCoMo control", f"n={o['n']}, $\\Delta$={o['delta']:.2f}")
    else:
        _pending(axD, "pending (run E16)")
    axA.set_ylabel("rate", fontsize=7); axC.set_ylabel("rate", fontsize=7)
    h = [plt.Rectangle((0, 0), 1, 1, color=PALETTE["bad"]), plt.Rectangle((0, 0), 1, 1, color=PALETTE["good"])]
    fig.legend(h, ["C4 (unbound) / baseline", "C5 / MBM-Core"], fontsize=6.0, frameon=False,
               loc="lower center", ncol=2, bbox_to_anchor=(0.55, 0.925), handlelength=1.1, columnspacing=1.4)
    return fig, "fig7_longrun_multiagent", "Long-Running Multi-Agent Workflows"


# ---------- Fig 8: main quantitative results (graph form of the results table) ----------
def fig8():
    import numpy as np
    d = load_json("results/eval/best-baseline-analysis.json") or load_json("results/eval/sota-best-baseline-analysis.json")
    # Headline figure omits the blinded-holdout (E7) 0->100 row to avoid a
    # "too-good-to-be-true" optic; it stays in RQ5 text and supplement Fig. S7.
    rows = ([r for r in d["rows"] if r.get("id") != "blinded_holdout"] + [d["aggregate"]]) if d else []
    # Single-column (portrait) layout: horizontal bars stacked vertically, with each evaluation's
    # label, paired n, and Delta[CI] stacked in the left margin so no wide right-hand column is
    # needed. Sized for one IEEE column (~3.45in) rather than a two-column span.
    fig = plt.figure(figsize=(3.45, 3.5))
    ax = fig.add_axes((0.40, 0.10, 0.57, 0.78))
    if not rows:
        _pending(ax, "pending (run E1-E7)")
        return fig, "fig8_main_results", "Main Quantitative Results: Memory-Selection Accuracy, Baseline vs MBM-Core"
    n = len(rows)
    ys = np.arange(n)[::-1]  # top row first
    h = 0.34
    for xt in [0.0, 0.25, 0.5, 0.75, 1.0]:
        ax.axvline(xt, color=PALETTE["grid"], lw=0.6, zorder=0)
    for row, y in zip(rows, ys):
        is_agg = row.get("id") == "aggregate"
        base = row["baseline_ffcr"]; treat = row["treatment_ffcr"]
        acc = PALETTE["accent_dk"] if is_agg else PALETTE["accent"]
        ax.barh(y + h / 2, base, height=h, color=PALETTE["bad"], zorder=3,
                edgecolor="white", linewidth=0.5)
        ax.barh(y - h / 2, treat, height=h, color=acc, zorder=3,
                edgecolor="white", linewidth=0.5)
        if base >= 0.86:  # near full: label inside the bar so it never clips the right edge
            ax.text(base - 0.02, y + h / 2, f"{base * 100:.0f}%", va="center", ha="right",
                    fontsize=5.4, color="white", fontweight="bold")
        else:
            ax.text(base + 0.02, y + h / 2, f"{base * 100:.0f}%", va="center", ha="left",
                    fontsize=5.4, color=PALETTE["bad"])
        ax.text(treat - 0.02, y - h / 2, f"{treat * 100:.0f}%", va="center", ha="right",
                fontsize=5.4, color="white", fontweight="bold")
    ax.set_xlim(0, 1.0)
    ax.set_ylim(-0.7, n - 0.3)
    # left margin: evaluation label, paired n, and Delta[CI] stacked per row
    for row, y in zip(rows, ys):
        is_agg = row.get("id") == "aggregate"
        lo, hi = row["ci95"]
        star = " ★" if row.get("significant_after_correction") else ""
        ax.text(-0.03, y + 0.22, row.get("label", row.get("id")),
                transform=ax.get_yaxis_transform(), ha="right", va="center",
                fontsize=6.3, fontweight=("bold" if is_agg else "normal"), clip_on=False)
        ax.text(-0.03, y - 0.01, f"n={row['paired_n']}",
                transform=ax.get_yaxis_transform(), ha="right", va="center",
                fontsize=5.2, color=PALETTE["muted"], clip_on=False)
        ax.text(-0.03, y - 0.25, f"$\\Delta$={row['ffcr_delta']:.2f} [{lo:.2f},{hi:.2f}]{star}",
                transform=ax.get_yaxis_transform(), ha="right", va="center",
                fontsize=5.2, fontweight=("bold" if is_agg else "normal"),
                color=(PALETTE["ink"] if is_agg else PALETTE["muted"]), clip_on=False)
    ax.set_yticks(ys); ax.set_yticklabels([])
    ax.set_xticks([0, 0.5, 1.0])
    ax.set_xticklabels(["0", "50", "100%"], fontsize=6.2)
    ax.set_xlabel("Memory-Selection Accuracy", fontsize=7)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.tick_params(left=False)
    hbars = [plt.Rectangle((0, 0), 1, 1, color=PALETTE["bad"]),
             plt.Rectangle((0, 0), 1, 1, color=PALETTE["accent"])]
    fig.legend(hbars, ["best baseline", "MBM-Core"],
               fontsize=6.2, frameon=False, loc="upper center", ncol=2,
               bbox_to_anchor=(0.62, 0.985), handlelength=1.0, columnspacing=1.2)
    return fig, "fig8_main_results", "Main Quantitative Results: Memory-Selection Accuracy, Baseline vs MBM-Core"


def _pending(ax, msg):
    ax.text(0.5, 0.5, msg, ha="center", va="center", fontsize=8,
            color=PALETTE["pending"], fontstyle="italic", transform=ax.transAxes)
    ax.set_xticks([])
    ax.set_yticks([])


# ---------- supplement placeholders ----------
SUPP_DEFS = [
    ("s01", "Full Benchmark Pipeline", "results/eval/benchmark-pipeline.json"),
    ("s02", "Complete Condition Matrix", "results/eval/condition-matrix.json"),
    ("s03", "Per-Scenario C4 vs C5 Effects", "results/coupled-memory-phase6-live-main40-r3-combined-2models.json"),
    ("s04", "Drop-In Replacement by Model", "results/dropin-protocol-replacement-live-main40-r3-combined.json"),
    ("s05", "SE-Native Dataset Composition", "data/se_native/source_manifest.json"),
    ("s06", "Strong-Baseline Rescue Results", "results/eval/e5-strong-baseline-combined.json"),
    ("s07", "Blinded Holdout Results", "results/eval/e7-holdout-combined.json"),
    # s08/s09/s10 removed: negative-controls, long-horizon stress, and cost/Pareto are already
    # shown in the main paper's Fig. 4 (robustness summary) panels B, A, and C respectively.
    ("s11", "Error Taxonomy Distribution", "results/eval/error-taxonomy.json"),
    ("s12", "Cross-Model Robustness", "results/eval/cross-model-analysis.json"),
    ("s13", "Native Framework Integration", "results/eval/native-framework-integration.json"),
    ("s14", "Artifact Reproducibility Pipeline", "results/eval/evidence-check.json"),
    ("s15", "Prompt and Schema Validation", "results/eval/prompt-schema-validation.json"),
]


# ---------- real, data-backed supplement renderers ----------
def _ffcr_by_condition(raw, conditions=None):
    out = {}
    for c in raw.get("cases", []):
        if c.get("api_error"):
            continue
        cond = c["condition"]
        d = out.setdefault(cond, [0, 0])
        d[1] += 1
        if c.get("model_success"):
            d[0] += 1
    return {k: (v[0] / v[1] if v[1] else 0) for k, v in out.items()}


def _supp_bars(ax, labels, values, colors, ylabel="FFCR"):
    yy = list(range(len(labels)))
    ax.barh(yy, values, color=colors, height=0.62)
    ax.set_yticks(yy)
    ax.set_yticklabels(labels, fontsize=7)
    ax.invert_yaxis()
    ax.set_xlim(0, 1.16)  # headroom so value labels on full (1.00) bars are not clipped
    ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
    ax.set_xlabel(ylabel, fontsize=8)
    for y, v in zip(yy, values):
        ax.text(v + 0.02, y, f"{v:.2f}", va="center", fontsize=6, color=PALETTE["muted"])


def draw_supp_real(sid, ax):
    """Draw real data for supplement figures that have generated sources. Returns True if drawn."""
    if sid == "s03":  # per-scenario C4 vs C5 (E1)
        raw = load_json("results/coupled-memory-phase6-live-main40-r3-combined-2models.json")
        if not raw:
            return False
        fams = sorted({c["scenario_type"] for c in raw["cases"]})
        def ffcr(fam, cond):
            it = [c for c in raw["cases"] if c["scenario_type"] == fam and c["condition"] == cond and not c.get("api_error")]
            return sum(1 for c in it if c.get("model_success")) / len(it) if it else 0
        import numpy as np
        y = np.arange(len(fams))
        ax.barh(y - 0.2, [ffcr(f, "C4") for f in fams], height=0.38, color=PALETTE["bad"], label="C4")
        ax.barh(y + 0.2, [ffcr(f, "C5") for f in fams], height=0.38, color=PALETTE["accent"], label="C5/MBM-Core")
        ax.set_yticks(y); ax.set_yticklabels([_FAMILY_SHORT.get(f, f.replace("_", " ")) for f in fams], fontsize=6.5)
        ax.invert_yaxis(); ax.set_xlim(0, 1.0); ax.set_xlabel("FFCR", fontsize=8)
        ax.legend(fontsize=6, frameon=False, loc="lower left", bbox_to_anchor=(0.0, 1.0),
                  ncol=2, handlelength=1.3, columnspacing=1.2)
        return True
    if sid == "s04":  # drop-in replacement by model (E2)
        raw = load_json("results/dropin-protocol-replacement-live-main40-r3-combined.json")
        if not raw:
            return False
        models = sorted({c["model"] for c in raw["cases"]})
        def ffcr(model, cond):
            it = [c for c in raw["cases"] if c["model"] == model and c["condition"] == cond and not c.get("api_error")]
            return sum(1 for c in it if c.get("model_success")) / len(it) if it else 0
        import numpy as np
        y = np.arange(len(models))
        ax.barh(y - 0.2, [ffcr(m, "C4") for m in models], height=0.38, color=PALETTE["bad"], label="legacy (C4)")
        ax.barh(y + 0.2, [ffcr(m, "C5") for m in models], height=0.38, color=PALETTE["accent"], label="message-bound (C5)")
        ax.set_yticks(y); ax.set_yticklabels(models, fontsize=7)
        ax.invert_yaxis(); ax.set_xlim(0, 1); ax.set_xlabel("FFCR", fontsize=8)
        ax.legend(fontsize=6, frameon=False, loc="lower left", bbox_to_anchor=(0.0, 1.0),
                  ncol=2, handlelength=1.3, columnspacing=1.2)
        return True
    if sid in ("s06", "s07"):  # strong-baseline / holdout FFCR by condition
        path = "results/eval/e5-strong-baseline-combined.json" if sid == "s06" else "results/eval/e7-holdout-combined.json"
        raw = load_json(path)
        if not raw:
            return False
        ff = _ffcr_by_condition(raw)
        order = [k for k in ["C4", "C4+run-filter", "C4+task-filter", "C4+status-filter", "C4+reader-filter",
                             "C4+policy-filter", "C4+all-static-filters", "C4+oracle-retriever", "C5"] if k in ff]
        labels = [("MBM-Core (C5)" if k == "C5" else k) for k in order]
        colors = [PALETTE["good"] if k == "C5" else PALETTE["bad"] for k in order]
        _supp_bars(ax, labels, [ff[k] for k in order], colors)
        return True
    # s08/s09/s10 (negative controls, stress curves, cost/Pareto) removed -- shown in main Fig. 4.
    if sid == "s12":  # cross-model robustness (E5 nano vs mini)
        nano = load_json("results/eval/e5-strong-baseline-gpt54nano.json")
        mini = load_json("results/eval/e5-strong-baseline-gpt54mini.json")
        if not nano or not mini:
            return False
        fn, fm = _ffcr_by_condition(nano), _ffcr_by_condition(mini)
        order = [k for k in ["C4", "C4+all-static-filters", "C4+oracle-retriever", "C5"] if k in fn and k in fm]
        import numpy as np
        y = np.arange(len(order))
        ax.barh(y - 0.2, [fn[k] for k in order], height=0.38, color=PALETTE["accent"], label="gpt-5.4-nano")
        ax.barh(y + 0.2, [fm[k] for k in order], height=0.38, color=PALETTE["accent_dk"], label="gpt-5.4-mini")
        ax.set_yticks(y); ax.set_yticklabels([("MBM-Core" if k == "C5" else k) for k in order], fontsize=6)
        ax.invert_yaxis(); ax.set_xlim(0, 1); ax.set_xlabel("FFCR", fontsize=8)
        ax.legend(fontsize=6, frameon=False, loc="lower left", bbox_to_anchor=(0.0, 1.0),
                  ncol=2, handlelength=1.3, columnspacing=1.2)
        return True
    return False


# ---------- structural / diagram supplement renderers (0..100 canvas) ----------
def draw_supp_diagram(sid, ax):
    if sid == "s01":  # benchmark pipeline flow
        stages = ["dataset\ngeneration", "live model\nruns", "deterministic\nevaluation", "analysis\n(bootstrap)", "tables &\nfigures"]
        x = 4
        for i, s in enumerate(stages):
            box(ax, x, 50, 15, 18, fc="#eef4ff", ec=ACCENT)
            t(ax, x + 7.5, 59, s, size=7, ha="center")
            if i < len(stages) - 1:
                arrow(ax, x + 15, 59, x + 18.6, 59, color=MUTED, lw=1.3)
            x += 18.6
        t(ax, 50, 80, "All stages carry command / model / seed / dataset+request+response hashes", size=7, ha="center", color=MUTED)
        t(ax, 50, 32, "results/eval convention  →  npm run eval:artifact:check (no-API replay)", size=7.5, ha="center", weight="bold")
        t(ax, 50, 22, "hash ledger: figure_manifest.json + table_manifest.json", size=6.8, ha="center", color=MUTED)
        return True
    if sid == "s02":  # condition matrix
        rows = [
            ("C0 freeform", "transcript", "none", "-"),
            ("C1 typed-env", "typed", "none", "-"),
            ("C4 scoped-mem", "causal", "scoped", "uncoupled"),
            ("C4+static filters", "causal", "scoped+filters", "static"),
            ("C5 MBM-Core", "causal", "governed", "message-bound"),
        ]
        cols = ["condition", "communication", "memory", "coupling"]
        cw = [26, 22, 24, 22]
        x0 = 4
        y = 80
        cx = x0
        for j, c in enumerate(cols):
            t(ax, cx + 2, y, c, size=7, weight="bold"); cx += cw[j]
        y -= 4
        ax.plot([x0, 96], [y, y], color=INK, lw=0.8)
        for r in rows:
            y -= 11
            cx = x0
            treat = r[0].startswith("C5")
            for j, cell in enumerate(r):
                t(ax, cx + 2, y, cell, size=6.6, color=(GOOD if treat else INK), weight=("bold" if treat and j == 0 else "normal")); cx += cw[j]
        t(ax, 50, 8, "C4 and C5 differ only by active-message binding", size=6.8, ha="center", color=MUTED, style="italic")
        return True
    if sid == "s05":  # SE-native composition (from manifest)
        man = load_json("data/se_native/source_manifest.json")
        if not man:
            return False
        repos = man.get("source_repos", {})
        per = man.get("per_family", 20)
        t(ax, 50, 86, f"{man.get('count', 100)} cases · {len(repos)} families · {per} per family", size=8, ha="center", weight="bold")
        y = 74
        for fam, repo in repos.items():
            box(ax, 4, y - 5, 40, 9, fc="#eef4ff", ec=ACCENT)
            t(ax, 6, y, fam.replace("_", " "), size=6.4)
            repo_disp = repo if len(repo) <= 24 else repo[:23] + "…"
            t(ax, 47, y, "→  " + repo_disp, size=6.2, color=MUTED)
            t(ax, 93, y, str(per), size=6.6, ha="right", weight="bold")
            y -= 12
        t(ax, 50, 7, "each case carries public source id + source hash; oracle hidden from model", size=6.4, ha="center", color=MUTED, style="italic")
        return True
    if sid == "s11":  # error taxonomy
        modes = [
            ("wrong-run", "twin_run, branch_merge, artifact"),
            ("wrong-task / scope", "private_summary, branch_merge"),
            ("stale / superseded", "superseded_policy, pause_resume"),
            ("unauthorized", "private_summary"),
            ("missing critical", "context_manifest, artifact"),
            ("unreconstructable", "audit_reconstruction"),
        ]
        t(ax, 50, 88, "Six communication-memory failure modes → scenario families", size=7.6, ha="center", weight="bold")
        y = 76
        for m, fams in modes:
            ax.scatter([7], [y], s=16, color=BAD, zorder=4)
            t(ax, 11, y, m, size=7, weight="bold", color=BAD)
            t(ax, 45, y, fams, size=6.4, color=MUTED)
            y -= 11
        t(ax, 50, 7, "FFCR = completion AND none of the six modes AND reconstructable", size=6.4, ha="center", color=MUTED, style="italic")
        return True
    if sid == "s13":  # framework integration (data-backed where native runs exist)
        integ = load_json("results/eval/native-framework-integration.json")
        by = {f["framework"]: f for f in (integ.get("frameworks", []) if integ else [])}
        t(ax, 50, 86, "Message-bound gate as a wrapper around framework comm/memory APIs", size=7.4, ha="center", weight="bold")
        fw = [("LangGraph", "checkpoint/store"), ("AutoGen", "conversation"), ("OpenHands-style", "trajectory")]
        x = 8
        for name, kind in fw:
            box(ax, x, 44, 24, 18, fc="#f3f4f6", ec=INK)
            t(ax, x + 12, 55, name, size=6.6, ha="center", weight="bold")
            t(ax, x + 12, 50, kind, size=6.0, ha="center", color=MUTED)
            d = by.get(name)
            if d:
                t(ax, x + 12, 46, f"C5 {d['c5_successes']}/{d['c5_cases']} · C4 0/{d['c4_cases']}", size=5.6, ha="center", color=GOOD)
            arrow(ax, x + 12, 44, x + 12, 34, color=GOOD, lw=1.3)
            x += 29
        box(ax, 18, 20, 60, 12, fc="#e8f3ec", ec=GOOD)
        t(ax, 48, 26, "message-bound memory gate (wrapper)", size=7.4, ha="center", weight="bold", color=GOOD)
        t(ax, 50, 9, "integration feasibility — not a superiority claim over these frameworks", size=6.4, ha="center", color=MUTED, style="italic")
        return True
    if sid == "s14":  # artifact replay
        steps = ["npm ci", "analyze results", "tables", "figures", "check"]
        x = 5
        for i, s in enumerate(steps):
            box(ax, x, 52, 16, 14, fc="#eef4ff", ec=ACCENT)
            t(ax, x + 8, 59, s, size=6.6, ha="center")
            if i < len(steps) - 1:
                arrow(ax, x + 16, 59, x + 18, 59, color=MUTED, lw=1.2)
            x += 18
        t(ax, 50, 40, "verifies: figure+table hashes · paper↔manifest coverage", size=6.8, ha="center")
        t(ax, 50, 32, "forbidden-claim audit · anonymization · reliability gates · metadata convention", size=6.8, ha="center")
        t(ax, 50, 18, "overall = PASS  ·  deterministic (mulberry32 bootstrap, fixed svg hashsalt)", size=7, ha="center", weight="bold", color=GOOD)
        return True
    if sid == "s15":  # prompt / schema validation
        t(ax, 50, 88, "Strict json_schema decision format (live_model.mjs)", size=7.6, ha="center", weight="bold")
        box(ax, 6, 40, 44, 40, fc="#eef4ff", ec=ACCENT)
        t(ax, 28, 75, "VISIBLE to model", size=7, ha="center", weight="bold", color=ACCENT)
        for i, f in enumerate(["query", "candidate memories (id+content)", "active_message (C5 only)", "protocol_rule"]):
            t(ax, 9, 68 - i * 6, "• " + f, size=6.3)
        box(ax, 52, 40, 42, 40, fc="#fdecea", ec=BAD)
        t(ax, 73, 75, "HIDDEN oracle (scoring)", size=7, ha="center", weight="bold", color=BAD)
        for i, f in enumerate(["expected_memory_ids", "forbidden_memory_ids", "binding metadata", "source hashes"]):
            t(ax, 55, 68 - i * 6, "• " + f, size=6.3)
        t(ax, 50, 28, "decision: { selected_memory_ids, answer, confidence, needs_review, selected_evidence }", size=6.4, ha="center", color=MUTED)
        t(ax, 50, 16, "scored by locked script; candidate ids anonymized where content is neutral", size=6.4, ha="center", color=MUTED, style="italic")
        return True
    return False


DIAGRAM_SIDS = {"s01", "s02", "s05", "s11", "s13", "s14", "s15"}


def supp_fig(sid, title, src):
    base = sid + "_" + "".join(ch if ch.isalnum() else "_" for ch in title.lower())
    base = "_".join(filter(None, base.split("_")))
    # diagram/structural figures on a blank canvas
    if sid in DIAGRAM_SIDS:
        fig = plt.figure(figsize=(4.8, 3.0))
        ax = blank_ax(fig)
        try:
            if draw_supp_diagram(sid, ax):
                return fig, base, title
        except Exception:
            pass
        plt.close(fig)
    # data-backed figures on a normal axes
    fig = plt.figure(figsize=(4.8, 3.0))
    ax = fig.add_axes((0.28, 0.16, 0.68, 0.78))
    try:
        drawn = draw_supp_real(sid, ax)
    except Exception:
        drawn = False
    if drawn:
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(labelsize=6)
        return fig, base, title
    plt.close(fig)
    fig = plt.figure(figsize=(4.8, 3.0))
    ax = blank_ax(fig)
    present = (ROOT / src).exists()
    t(ax, 1, 97, sid.upper(), size=6.5, ha="left", color=PALETTE["muted"])
    box(ax, 6, 16, 88, 66, fc=PALETTE["panel"], ec=PALETTE["grid"])
    t(ax, 50, 50, "source data pending", size=10, ha="center", color=PALETTE["pending"])
    t(ax, 50, 9, "Regenerated by tools/build_figures.py --supplement", size=6.0,
      ha="center", color=PALETTE["muted"], style="italic")
    return fig, base, title


# ---------- save + manifest ----------
def save(fig, base, title, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    svg = out_dir / f"{base}.svg"
    pdf = out_dir / f"{base}.pdf"
    png = out_dir / f"{base}.png"
    # strip embedded timestamps so outputs are byte-reproducible (stable hashes across runs)
    fig.savefig(svg, format="svg", facecolor="white", metadata={"Date": None})
    fig.savefig(pdf, format="pdf", facecolor="white", metadata={"CreationDate": None})
    fig.savefig(png, format="png", facecolor="white", metadata={"Software": None})
    plt.close(fig)
    fid = base.split("_")[0]
    return {
        "id": fid,
        "title": title,
        "output_svg": rel(svg),
        "output_png": rel(png),
        "output_pdf": rel(pdf),
        "sha256_svg": sha256_file(svg),
        "sha256_png": sha256_file(png),
        "sha256_pdf": sha256_file(pdf),
    }


# ---------- static (hand-authored) main figures ----------
# id -> (output basename, title, source SVG). These are not drawn by matplotlib; the committed
# svg/pdf/png are the source of truth and are hashed into the manifest like any other figure.
STATIC_MAIN = {
    "fig1": ("fig1_workflow_mismatch", "Communication-Memory Mismatch",
             ROOT / "figures" / "src" / "fig1_workflow_mismatch.svg"),
    "fig2": ("fig2_message_bound_gate", "Two-Stage Message-Bound Shared-Memory Gate",
             ROOT / "figures" / "src" / "fig2_message_bound_gate.svg"),
    "fig10": ("fig10_coverage_matrix", "Complete-Mediation Coverage Matrix",
              ROOT / "figures" / "src" / "fig10_coverage_matrix.svg"),
}


def _manifest_entry_for(fid, base, title, out_dir):
    svg = out_dir / f"{base}.svg"
    pdf = out_dir / f"{base}.pdf"
    png = out_dir / f"{base}.png"
    return {
        "id": fid, "title": title,
        "output_svg": rel(svg), "output_png": rel(png), "output_pdf": rel(pdf),
        "sha256_svg": sha256_file(svg), "sha256_png": sha256_file(png), "sha256_pdf": sha256_file(pdf),
    }


def build_static(fid, out_dir=FIG_DIR, regenerate=False):
    """Record (and optionally regenerate from SVG source) a hand-authored static figure.

    By default this only re-hashes the committed svg/pdf/png so routine builds stay deterministic
    and do not churn the binary outputs. Pass regenerate=True (or `--figure fig1`) to rebuild the
    PDF/PNG from the source SVG via rsvg-convert.
    """
    base, title, src = STATIC_MAIN[fid]
    out_dir.mkdir(parents=True, exist_ok=True)
    svg = out_dir / f"{base}.svg"
    pdf = out_dir / f"{base}.pdf"
    png = out_dir / f"{base}.png"
    if regenerate:
        if not shutil.which("rsvg-convert"):
            raise SystemExit("rsvg-convert not found; cannot regenerate static figure " + fid)
        if not src.exists():
            raise SystemExit("missing source SVG for static figure: " + str(src))
        shutil.copyfile(src, svg)
        subprocess.run(["rsvg-convert", "-f", "pdf", "-o", str(pdf), str(src)], check=True)
        subprocess.run(["rsvg-convert", "-f", "png", "-w", "2000", "-o", str(png), str(src)], check=True)
    return _manifest_entry_for(fid, base, title, out_dir)


def update_manifest(entries):
    prior = load_json(MANIFEST) or {"figures": []}
    by_id = {f["id"]: f for f in prior.get("figures", [])}
    for e in entries:
        by_id[e["id"]] = e
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    out = {
        "generated_at": __import__("datetime").datetime.now().astimezone().isoformat(),
        "script": "tools/build_figures.py",
        "figures": sorted(by_id.values(), key=lambda f: f["id"]),
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")


# fig3 (best-baseline forest), fig5 (per-scenario), and fig6 (adversarial separation) are NOT
# referenced in the manuscript body; their content is covered by Fig. 8 (main results) and the
# supplement (S3/S6/S7). Removed from generation to avoid orphan figures.
def fig12():
    # Gate 2.0 schedule ablation (RQ4/RQ5): each adversarial schedule (rows) under the four ablation
    # conditions (cols). Green = the attack was blocked, red = the unauthorized outcome occurred. Drawn from
    # results/eval/gate2-schedule-eval.json (the same matrix the gate2:schedule harness asserts).
    d = load_json("results/eval/gate2-schedule-eval.json")
    fig = plt.figure(figsize=(3.45, 2.95))
    ax = fig.add_axes((0.47, 0.16, 0.50, 0.66))
    if not d:
        _pending(ax, "pending (run gate2:schedule)")
        return fig, "fig12_gate2_ablation", "Gate 2.0 Schedule Ablation"
    cond_keys = [c["key"] for c in d["conditions"]]
    cond_labels = ["C5", "C6", "C7", "G2"]
    SLAB = {
        "merge_unresolved_conflict": "merge: unresolved conflict",
        "same_key_write_after_prepare": "same-key write after prepare",
        "token_replay": "token replay",
        "action_substitution": "action substitution",
        "resolution_accepts_both": "resolution accepts both",
        "adoption_authority_forgery": "adopt-authority forgery",
        "logical_key_aliasing": r"logical-key aliasing $\dagger$",
        "reasoning_executor_influence": r"reasoning$\rightarrow$executor $\dagger$",
    }
    sched = list(d["matrix"].keys())
    nrows, ncols = len(sched), len(cond_keys)
    for i, s in enumerate(sched):
        for j, ck in enumerate(cond_keys):
            blocked = d["matrix"][s][ck]["blocked"]
            ax.add_patch(plt.Rectangle((j, nrows - 1 - i), 1, 1,
                         facecolor=PALETTE["good"] if blocked else PALETTE["bad"], edgecolor="white", lw=1.6))
    ax.set_xlim(0, ncols); ax.set_ylim(0, nrows)
    ax.set_xticks([j + 0.5 for j in range(ncols)]); ax.set_xticklabels(cond_labels, fontsize=7.2)
    ax.set_yticks([nrows - 1 - i + 0.5 for i in range(nrows)])
    ax.set_yticklabels([SLAB[s] for s in sched], fontsize=6.3)
    ax.xaxis.tick_top(); ax.tick_params(length=0)
    for sp in ax.spines.values():
        sp.set_visible(False)
    h = [plt.Rectangle((0, 0), 1, 1, color=PALETTE["good"]), plt.Rectangle((0, 0), 1, 1, color=PALETTE["bad"])]
    fig.legend(h, ["blocked", "admitted"], fontsize=6.6, frameon=False, loc="lower center",
               ncol=2, bbox_to_anchor=(0.62, 0.01), handlelength=1.1, columnspacing=1.2)
    return fig, "fig12_gate2_ablation", "Gate 2.0 Schedule Ablation"


def fig13():
    # Hard C4-vs-kernel separation: content-blind, kernel-level adversarial families (rows) under C4 (ungated,
    # no mediation) vs C5 (the full security kernel). Red = the attack succeeded (exploited), green = blocked.
    # Drawn from results/eval/hard-separation-eval.json (the matrix `npm run hard:separation` asserts). The
    # separation is the MEDIATION property (the kernel's contribution), not a selection-accuracy gain.
    d = load_json("results/eval/hard-separation-eval.json")
    fig = plt.figure(figsize=(3.45, 2.65))
    ax = fig.add_axes((0.50, 0.20, 0.30, 0.58))
    if not d:
        _pending(ax, "pending (run hard:separation)")
        return fig, "fig13_hard_separation", "Hard C4-vs-Kernel Separation"
    FLAB = {
        "forged_field_plant": "forged-field plant",
        "cross_run_contamination": "cross-run contamination",
        "authenticated_injected_writer": "injected writer (integrity)",
        "merge_laundering": "merge laundering",
        "commit_time_count_collision": "count-collision (TOCTOU)",
        "action_substitution": "intent substitution",
        "post_auth_action_substitution": "post-auth substitution",
    }
    fams = [f["family"] for f in d["families"]]
    nrows = len(fams)
    for i, f in enumerate(d["families"]):
        for j, key in enumerate(("c4_attack_success", "c5_attack_success")):
            exploited = f[key]
            ax.add_patch(plt.Rectangle((j, nrows - 1 - i), 1, 1,
                         facecolor=PALETTE["bad"] if exploited else PALETTE["good"], edgecolor="white", lw=1.6))
    ax.set_xlim(0, 2); ax.set_ylim(0, nrows)
    c4r = round(d["c4_attack_success_rate"] * 100); c5r = round(d["c5_attack_success_rate"] * 100)
    ax.set_xticks([0.5, 1.5]); ax.set_xticklabels([f"C4\n{c4r}%", f"C5\n{c5r}%"], fontsize=7.0)
    ax.set_yticks([nrows - 1 - i + 0.5 for i in range(nrows)])
    ax.set_yticklabels([FLAB.get(f, f) for f in fams], fontsize=6.3)
    ax.xaxis.tick_top(); ax.tick_params(length=0)
    for sp in ax.spines.values():
        sp.set_visible(False)
    h = [plt.Rectangle((0, 0), 1, 1, color=PALETTE["good"]), plt.Rectangle((0, 0), 1, 1, color=PALETTE["bad"])]
    fig.legend(h, ["blocked", "exploited"], fontsize=6.6, frameon=False, loc="lower center",
               ncol=2, bbox_to_anchor=(0.6, 0.01), handlelength=1.1, columnspacing=1.2)
    return fig, "fig13_hard_separation", "Hard C4-vs-Kernel Separation"


MAIN = {"fig4": fig4, "fig7": fig7, "fig8": fig8, "fig12": fig12, "fig13": fig13}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--main", action="store_true")
    ap.add_argument("--supplement", action="store_true")
    ap.add_argument("--figure", default=None)
    args = ap.parse_args()
    configure_style()

    do_main = args.main or (not args.supplement and not args.figure)
    do_supp = args.supplement or (not args.main and not args.figure)
    entries = []

    if args.figure:
        if args.figure in STATIC_MAIN:
            # explicit single-figure request regenerates the static figure from its SVG source
            entries.append(build_static(args.figure, regenerate=True))
        else:
            fn = MAIN.get(args.figure)
            if not fn:
                raise SystemExit(f"unknown figure: {args.figure}")
            fig, base, title = fn()
            entries.append(save(fig, base, title, FIG_DIR))
    else:
        if do_main:
            for fid in STATIC_MAIN:  # hand-authored static figures (hashed, not redrawn)
                entries.append(build_static(fid, regenerate=False))
            for k in ("fig4", "fig7", "fig8", "fig12", "fig13"):
                fig, base, title = MAIN[k]()
                entries.append(save(fig, base, title, FIG_DIR))
        if do_supp:
            for sid, title, src in SUPP_DEFS:
                fig, base, t2 = supp_fig(sid, title, src)
                entries.append(save(fig, base, t2, SUPP_DIR))

    update_manifest(entries)
    print(f"[eval:figures] wrote {len(entries)} figure(s) as SVG+PDF+PNG; manifest={rel(MANIFEST)}")


if __name__ == "__main__":
    main()
