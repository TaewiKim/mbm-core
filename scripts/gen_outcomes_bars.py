"""Generate the measured-outcomes bar figure (main Fig.3): a QUANTITATIVE companion to the scorecard.
Across three model families on the main split, it shows the dual measured effect of the gate (C4 ungated
vs C5 MBM): forbidden-memory selections fall to zero (security) while task success rises (utility). Numbers
are read from the committed phase-6 analysis JSONs so they stay honest/reproducible.

Run: python scripts/gen_outcomes_bars.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "figures" / "src" / "fig_outcomes_bars.svg"
FILES = [
    ("gpt-5.4-nano", "results/coupled-memory-phase6-live-main40-gpt5nano-analysis.json"),
    ("gpt-5.4-mini", "results/coupled-memory-phase6-live-main40-gpt5mini-analysis.json"),
    ("gemini-2.5-flash", "results/coupled-memory-phase6-live-main40-gemini25flash-analysis.json"),
]
MODELS = []
for name, rel in FILES:
    d = json.load(open(ROOT / rel, encoding="utf-8"))
    MODELS.append({
        "name": name,
        "succ_c4": 100.0 * d["c4_successes"] / d["c4_cases"],
        "succ_c5": 100.0 * d["c5_successes"] / d["c5_cases"],
        "forb_c4": d["c4_forbidden_memory"],
        "forb_c5": d["c5_forbidden_memory"],
    })

C4 = "#d8775a"; C4S = "#b23a17"; C5 = "#3bb38a"; C5S = "#0b6b4f"
W = 384
plot_l, plot_r = 36, 376
gw = (plot_r - plot_l) / len(MODELS)   # group width
bw = 30                                 # bar width


def bars(s, y0, height, vals, fmt, vmax):
    """Draw one panel's grouped bars. vals: list of (c4, c5). y0=baseline, height=px for vmax."""
    for g, (v4, v5) in enumerate(vals):
        gc = plot_l + gw * g + gw / 2
        for (v, x, fill, stroke) in [(v4, gc - bw - 3, C4, C4S), (v5, gc + 3, C5, C5S)]:
            h = max(2.0, height * (v / vmax)) if v > 0 else 0
            if h > 0:
                s.append(f'<rect x="{x:.0f}" y="{y0-h:.0f}" width="{bw}" height="{h:.0f}" rx="2" fill="{fill}" stroke="{stroke}" stroke-width="1"/>')
            lbl = fmt(v)
            s.append(f'<text x="{x+bw/2:.0f}" y="{(y0-h-3) if h>10 else y0-4:.0f}" class="b" fill="{stroke}" font-size="9" text-anchor="middle">{lbl}</text>')


def main():
    H = 302
    s = []
    s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t d">')
    s.append('<title id="t">Measured outcomes: the gate drives forbidden-memory selections to zero while task success rises</title>')
    s.append('<desc id="d">Two bar panels over three model families on the main split, comparing the ungated control C4 with the message-bound monitor C5. Top: forbidden-memory selections fall to zero under C5 for every model. Bottom: task success rises under C5 for every model. The gate removes cross-context contamination without sacrificing utility.</desc>')
    s.append('<defs><style>text{font-family:DejaVuSans}.b{font-family:DejaVuSans-Bold}</style></defs>')
    s.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="#ffffff"/>')
    s.append(f'<text x="{W/2:.0f}" y="18" class="b" fill="#1f2937" font-size="13" text-anchor="middle">Measured outcomes: C5 (MBM) vs C4 (ungated)</text>')
    # legend (centered, under the title, clear of panel labels)
    s.append(f'<rect x="116" y="26" width="11" height="9" rx="2" fill="{C4}" stroke="{C4S}"/><text x="130" y="34" fill="#475569" font-size="9" text-anchor="start">C4 ungated</text>')
    s.append(f'<rect x="208" y="26" width="11" height="9" rx="2" fill="{C5}" stroke="{C5S}"/><text x="222" y="34" fill="#475569" font-size="9" text-anchor="start">C5 MBM (main split)</text>')

    # Panel A: forbidden-memory (security, lower better)
    s.append(f'<text x="8" y="54" class="b" fill="#a23a17" font-size="10.5" text-anchor="start">(a) Forbidden-memory selections &#8595; (lower is better)</text>')
    yA = 146
    s.append(f'<line x1="{plot_l-2}" y1="{yA}" x2="{plot_r}" y2="{yA}" stroke="#cbd5e1" stroke-width="1"/>')
    fmaxv = max(m["forb_c4"] for m in MODELS) or 1
    bars(s, yA, 74, [(m["forb_c4"], m["forb_c5"]) for m in MODELS], lambda v: str(int(v)), fmaxv * 1.12)

    # Panel B: task success (utility, higher better)
    s.append(f'<text x="8" y="172" class="b" fill="#0b6b4f" font-size="10.5" text-anchor="start">(b) Task success (%) &#8593; (higher is better)</text>')
    yB = 284
    s.append(f'<line x1="{plot_l-2}" y1="{yB}" x2="{plot_r}" y2="{yB}" stroke="#cbd5e1" stroke-width="1"/>')
    bars(s, yB, 94, [(m["succ_c4"], m["succ_c5"]) for m in MODELS], lambda v: f"{v:.0f}", 100.0)
    for g, m in enumerate(MODELS):
        gc = plot_l + gw * g + gw / 2
        s.append(f'<text x="{gc:.0f}" y="{yB+14:.0f}" fill="#334155" font-size="9" text-anchor="middle">{m["name"]}</text>')

    s.append('</svg>')
    OUT.write_text("\n".join(s) + "\n", encoding="utf-8")
    print(f"wrote {OUT}; " + " | ".join(f'{m["name"]}: forb {m["forb_c4"]}->{m["forb_c5"]}, succ {m["succ_c4"]:.0f}->{m["succ_c5"]:.0f}%' for m in MODELS))


if __name__ == "__main__":
    main()
