"""Generate the complete-mediation coverage MATRIX figure (main Fig.3) from
results/baseline-separation-check.json. Data-driven: an attack-family x defense grid where each cell is
full mediation (admits 0 invalid on all 20 cases) or bypassed. The MBM-Core column is the only all-pass
column. Single-column (portrait) so it fits one IEEE column. Emits
figures/src/fig10_coverage_matrix.svg.

Run: python scripts/gen_coverage_matrix.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "results" / "baseline-separation-check.json"
OUT = ROOT / "figures" / "src" / "fig10_coverage_matrix.svg"

# columns = defenses (MBM last, highlighted); rows = attack families
DEFENSES = [
    ("C4+all-static-filters", "static"),
    ("C4+all-static-filters+source-exists", "+src"),
    ("C4+abac", "ABAC"),
    ("C4+rebac-provenance-graph", "ReBAC"),
    ("C4+capability-token", "cap"),
    ("C5", "MBM"),
]
FAMILIES = [
    ("twin_run_shared_memory_contamination", "twin-run contamination"),
    ("pause_resume_deferred_constraint", "pause/resume constraint"),
    ("crash_retry_with_superseded_policy", "crash-retry policy"),
    ("branch_merge_with_conflicting_memories", "branch/merge conflict"),
    ("artifact_dependent_handoff", "artifact handoff"),
    ("private_memory_summary", "private-summary leak"),
    ("long_horizon_drift", "long-horizon drift"),
    ("audit_reconstruction", "audit reconstruction"),
    ("graph_only_sibling_branch_provenance", "graph-only sibling plant*"),
]


def main():
    d = json.load(open(DATA, encoding="utf-8"))["checked"]
    per = d["per_family"]
    totals = dict(d["baseline_totals"]); totals["C5"] = d["treatment_passed"]
    grand = d["total_cases"]

    L = 8; label_w = 152; col_w = 36
    grid_x = L + label_w
    W = grid_x + col_w * len(DEFENSES) + 8
    top = 72; row_h = 27
    H = top + row_h * (len(FAMILIES) + 1) + 22  # +1 totals row

    s = []
    s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t d">')
    s.append('<title id="t">Complete-mediation coverage: only MBM-Core clears every attack family</title>')
    s.append('<desc id="d">An attack-family by defense matrix. Each cell shows whether a defense fully mediates a family (admits zero invalid records across all 20 cases) or is bypassed. Every single-paradigm baseline is bypassed by at least one family; the MBM-Core column is the only one that clears all nine families, mediating all 180 cases.</desc>')
    s.append('<defs><style>text{font-family:DejaVuSans}.b{font-family:DejaVuSans-Bold}</style></defs>')
    s.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="#ffffff"/>')
    s.append(f'<text x="{W/2:.0f}" y="22" class="b" fill="#1f2937" font-size="13.5" text-anchor="middle">Only MBM-Core clears every attack family</text>')
    s.append(f'<text x="{W/2:.0f}" y="40" fill="#6b7280" font-size="10" text-anchor="middle">full mediation (0 invalid / 20 cases) vs. bypassed</text>')

    mbm_idx = len(DEFENSES) - 1
    mbm_x = grid_x + col_w * mbm_idx
    # highlight box spans from above the column header down to the bottom of the totals row
    hl_top = 52
    hl_bottom = top + row_h * (len(FAMILIES) + 1) + 4  # totals-row bottom + padding (clears the "180")
    s.append(f'<rect x="{mbm_x+1}" y="{hl_top}" width="{col_w-2}" height="{hl_bottom-hl_top}" rx="6" fill="#eafaf3" stroke="#009e73" stroke-width="2"/>')
    s.append(f'<text x="{L}" y="65" class="b" fill="#475569" font-size="10" text-anchor="start">family / defense</text>')
    for j, (_, short) in enumerate(DEFENSES):
        cx = grid_x + col_w * j + col_w / 2
        cls = ' class="b"' if j == mbm_idx else ''
        col = "#0b6b4f" if j == mbm_idx else "#334155"
        s.append(f'<text x="{cx:.0f}" y="65"{cls} fill="{col}" font-size="10.5" text-anchor="middle">{short}</text>')

    for i, (fk, fname) in enumerate(FAMILIES):
        ry = top + row_h * i
        s.append(f'<text x="{L}" y="{ry+row_h/2+4:.0f}" fill="#1f2937" font-size="11" text-anchor="start">{fname}</text>')
        for j, (dk, _) in enumerate(DEFENSES):
            p = per[fk]["pass"].get(dk, 0); tot = per[fk]["total"]; ok = p >= tot
            is_mbm = j == mbm_idx
            cx = grid_x + col_w * j
            if ok:
                fill = "#bdebd6" if is_mbm else "#d9f2e6"; stroke = "#0b6b4f" if is_mbm else "#5cc79b"; sym = "&#10003;"; symcol = "#0b6b4f"
            else:
                fill = "#fbe0d4"; stroke = "#d55e00"; sym = "&#10007;"; symcol = "#b23a17"
            s.append(f'<rect x="{cx+4}" y="{ry+4}" width="{col_w-8}" height="{row_h-8}" rx="4" fill="{fill}" stroke="{stroke}" stroke-width="1"/>')
            s.append(f'<text x="{cx+col_w/2:.0f}" y="{ry+row_h/2+5:.0f}" class="b" fill="{symcol}" font-size="13" text-anchor="middle">{sym}</text>')

    ty = top + row_h * len(FAMILIES)
    s.append(f'<text x="{L}" y="{ty+row_h/2+4:.0f}" class="b" fill="#475569" font-size="10" text-anchor="start">mediated /{grand}</text>')
    for j, (dk, _) in enumerate(DEFENSES):
        cx = grid_x + col_w * j + col_w / 2
        is_mbm = j == mbm_idx
        col = "#0b6b4f" if is_mbm else ("#b23a17" if totals[dk] < grand else "#1f2937")
        s.append(f'<text x="{cx:.0f}" y="{ty+row_h/2+4:.0f}" class="b" fill="{col}" font-size="10" text-anchor="middle">{totals[dk]}</text>')

    s.append(f'<text x="{L}" y="{H-8}" fill="#6b7280" font-size="9" text-anchor="start">* graph-only sibling-branch plant: only recomputed causal reachability rejects it.</text>')
    s.append('</svg>')
    OUT.write_text("\n".join(s) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({W}x{H})")


if __name__ == "__main__":
    main()
