"""Generate the HEADLINE scorecard figure (main Fig.2): one figure that shows the whole core result.
Rows = defense paradigms; columns = the per-record mediation count (/180) plus the four discriminating
capabilities (recomputed reachability P7, integrity flow P8, set-level merge resolution, replay audit).
MBM-Core is the only row complete on every axis. Mediation numbers are read from the committed results
(baseline-separation-check.json + combined-baseline-residual.json) so they stay honest/reproducible; the
four binary capability columns encode established paper-level results (see comments).

Run: python scripts/gen_headline_scorecard.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEP = json.load(open(ROOT / "results" / "baseline-separation-check.json", encoding="utf-8"))["checked"]
COMB = json.load(open(ROOT / "results" / "combined-baseline-residual.json", encoding="utf-8"))
OUT = ROOT / "figures" / "src" / "fig_headline_scorecard.svg"

bt = SEP["baseline_totals"]
GRAND = SEP["total_cases"]            # 180
MBM = SEP["treatment_passed"]        # 180
COMB_EXISTS = COMB["combined_conventional_exists_mediated"]  # 160
COMB_CAUSAL = COMB["combined_causal_mediated"]               # 180

# (label, mediated/180, reach P7, integ P8, set-merge, audit). Binary: 1=yes,0=no.
# Reach: only graph-reachability defenses (ReBAC, combined+reach, MBM). Integ/Set/Audit: only MBM
# (P8 integrity is no access-control predicate; set-level is Prop.1's Stage-2; replay audit is S3 -- an
# ungated baseline keeps no decision log). These mirror Tables III/IV and S3/S4.
ROWS = [
    ("Static filters",      bt["C4+all-static-filters"],            0, 0, 0, 0),
    ("ABAC",                bt["C4+abac"],                          0, 0, 0, 0),
    ("ReBAC graph",         bt["C4+rebac-provenance-graph"],        1, 0, 0, 0),
    ("Capability",          bt["C4+capability-token"],              0, 0, 0, 0),
    ("Combined (conv.)",    COMB_EXISTS,                            0, 0, 0, 0),
    ("Combined +reach.",    COMB_CAUSAL,                            1, 0, 0, 0),
    ("MBM-Core (ours)",     MBM,                                    1, 1, 1, 1),
]
COLS = ["Reach", "Integ.", "Set", "Audit"]  # P7, P8, set-merge, audit


def main():
    L = 8
    label_w = 112
    med_w = 56
    bin_w = 44
    grid_x = L + label_w               # start of mediation column
    bin_x = grid_x + med_w             # start of binary columns
    W = bin_x + bin_w * len(COLS) + 6
    title_h = 56
    row_h = 27
    top = title_h + 16                 # first data row y-top
    H = top + row_h * len(ROWS) + 24
    mbm_i = len(ROWS) - 1

    s = []
    s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t d">')
    s.append('<title id="t">MBM-Core is the only defense complete on every axis</title>')
    s.append('<desc id="d">A scorecard of defense paradigms (rows) against five axes (columns): per-record mediation out of 180 cases, recomputed causal reachability (P7), integrity flow (P8), set-level merge resolution, and replay-detectable audit. Every conventional paradigm, and even their combination, fails at least one axis; only MBM-Core is complete on all five.</desc>')
    s.append('<defs><style>text{font-family:DejaVuSans}.b{font-family:DejaVuSans-Bold}</style></defs>')
    s.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="#ffffff"/>')
    s.append(f'<text x="{W/2:.0f}" y="22" class="b" fill="#1f2937" font-size="13" text-anchor="middle">Only MBM-Core is complete on every axis</text>')
    s.append(f'<text x="{W/2:.0f}" y="39" fill="#6b7280" font-size="9.5" text-anchor="middle">mediation (/{GRAND} cases) and the four discriminating capabilities</text>')

    # MBM highlight band (behind its row)
    hy = top + row_h * mbm_i
    s.append(f'<rect x="{L}" y="{hy-1}" width="{W-2*L}" height="{row_h+2}" rx="6" fill="#eafaf3" stroke="#009e73" stroke-width="2"/>')

    # column headers
    s.append(f'<text x="{L+4}" y="{top-6}" class="b" fill="#475569" font-size="9.5" text-anchor="start">defense</text>')
    s.append(f'<text x="{grid_x+med_w/2:.0f}" y="{top-6}" class="b" fill="#334155" font-size="9.5" text-anchor="middle">/{GRAND}</text>')
    for j, c in enumerate(COLS):
        cx = bin_x + bin_w * j + bin_w / 2
        s.append(f'<text x="{cx:.0f}" y="{top-6}" class="b" fill="#334155" font-size="9.5" text-anchor="middle">{c}</text>')

    for i, (label, med, *bins) in enumerate(ROWS):
        ry = top + row_h * i
        cy = ry + row_h / 2 + 4
        is_mbm = i == mbm_i
        lab_col = "#0b6b4f" if is_mbm else "#1f2937"
        lab_cls = ' class="b"' if is_mbm else ''
        s.append(f'<text x="{L+4}" y="{cy:.0f}"{lab_cls} fill="{lab_col}" font-size="10.5" text-anchor="start">{label}</text>')
        # mediation number, colored by completeness
        num_col = "#0b6b4f" if med == GRAND else ("#b23a17" if med <= 40 else "#a15c00")
        s.append(f'<text x="{grid_x+med_w/2:.0f}" y="{cy:.0f}" class="b" fill="{num_col}" font-size="11" text-anchor="middle">{med}</text>')
        for j, v in enumerate(bins):
            bx = bin_x + bin_w * j
            if v:
                fill = "#bdebd6" if is_mbm else "#d9f2e6"; stroke = "#0b6b4f" if is_mbm else "#5cc79b"; sym = "&#10003;"; sc = "#0b6b4f"
            else:
                fill = "#fbe0d4"; stroke = "#d8775a"; sym = "&#10007;"; sc = "#b23a17"
            s.append(f'<rect x="{bx+5}" y="{ry+4}" width="{bin_w-10}" height="{row_h-8}" rx="4" fill="{fill}" stroke="{stroke}" stroke-width="1"/>')
            s.append(f'<text x="{bx+bin_w/2:.0f}" y="{ry+row_h/2+5:.0f}" class="b" fill="{sc}" font-size="12.5" text-anchor="middle">{sym}</text>')

    fy = top + row_h * len(ROWS) + 13
    s.append(f'<text x="{L+4}" y="{fy:.0f}" fill="#6b7280" font-size="8.5" text-anchor="start">Reach=recomputed causal reachability (P7); Integ.=integrity flow (P8); Set=set-level merge (Prop.1); Audit=replay-detectable.</text>')
    s.append('</svg>')
    OUT.write_text("\n".join(s) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({W}x{H}); mediation row = static {ROWS[0][1]}, abac {ROWS[1][1]}, rebac {ROWS[2][1]}, cap {ROWS[3][1]}, comb {ROWS[4][1]}/{ROWS[5][1]}, MBM {ROWS[6][1]}")


if __name__ == "__main__":
    main()
