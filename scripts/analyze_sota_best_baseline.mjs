// E6 best evaluated baseline aggregate analysis for .
// Produces results/eval/best-baseline-analysis.{json,csv}, the data source for Fig. 3.
//
// For each evaluation row, computes the paired Failure-Free Completion Rate (FFCR) delta
//   delta = MBM-Core(C5) FFCR - best non-binding/evaluated baseline FFCR
// with a 95% paired bootstrap CI. The "best baseline" is chosen per scenario family
// (max FFCR among the listed baseline conditions) and then paired against the treatment.
//
// Rows whose source result files do not yet exist are emitted with status "pending" so the
// figure renders the available real data and fills in as live experiments complete.
import {
  bootstrapPairedDelta,
  bootstrapClusteredPairedDelta,
  holmBonferroni,
  isoStamp,
  leaveOneClusterOut,
  mcnemar,
  parseArgs,
  readJsonIfExists,
  writeJson,
  writeText,
} from "./eval_lib.mjs";

const TREATMENT = "C5";

// Row -> source raw result file(s) + the non-C5 baseline conditions to choose the best from.
const ROWS = [
  {
    id: "controlled_protocol_swap",
    label: "controlled protocol-swap (E1)",
    experiment: "E1",
    sources: ["results/coupled-memory-phase6-live-main40-r3-combined-2models.json"],
    baselineConditions: ["C4"],
    baselineLabel: "C4 (ungated control)",
    seed: 2701,
  },
  {
    id: "dropin_replacement",
    label: "drop-in replacement (E2)",
    experiment: "E2",
    sources: ["results/dropin-protocol-replacement-live-main40-r3-combined.json"],
    baselineConditions: ["C4"],
    baselineLabel: "legacy shared-memory wrapper",
    seed: 2702,
  },
  {
    id: "se_native_workflow",
    label: "SE-native workflow (E3)",
    experiment: "E3",
    sources: ["results/eval/e3-se-native-combined.json"],
    baselineConditions: ["C4"],
    baselineLabel: "C4 (ungated control)",
    seed: 2703,
  },
  {
    id: "strong_baseline_rescue",
    label: "strong-baseline rescue (E5)",
    experiment: "E5",
    sources: ["results/eval/e5-strong-baseline-combined.json"],
    baselineConditions: [
      "C4",
      "C4+run-filter",
      "C4+task-filter",
      "C4+status-filter",
      "C4+reader-filter",
      "C4+policy-filter",
      "C4+all-static-filters",
      "C4+all-static-filters+source-exists",
      "C4+abac",
      "C4+rebac-provenance-graph",
      "C4+capability-token",
      "C4+oracle-retriever",
    ],
    baselineLabel: "best conventional-authorization baseline (static / FK / ABAC / ReBAC / capability / oracle)",
    seed: 2705,
  },
  {
    id: "blinded_holdout",
    label: "blinded adversarial holdout (E7)",
    experiment: "E7",
    sources: ["results/eval/e7-holdout-combined.json"],
    baselineConditions: ["C4", "C4+all-static-filters", "C4+all-static-filters+source-exists", "C4+oracle-retriever"],
    baselineLabel: "best holdout baseline (incl. source-exists FK)",
    seed: 2707,
  },
];

function familyOf(c) {
  return c.scenario_type ?? c.scenario_id ?? "unknown";
}

// Reconstructability is MEASURED, not synthesized from the condition label (review M2): the harness
// records event_graph_reconstructability per case by replaying the gate's audit log and confirming
// it recovers exactly the admitted set (benchmarks/coupled_memory/scenarios.mjs reconstructAudit).
// CRITICAL (review M4): a case whose runner does NOT record this field is "not measured" and must be
// EXCLUDED from any full-FFCR aggregate -- NOT coded as a failure (0). Coding missing-as-0 previously
// mixed runners that measure reconstructability (E1/E2) with runners that do not (E3/E5/E7) and with
// ungated conditions that keep no trail, producing a heterogeneous aggregate. We return null when the
// field is absent so the full-FFCR metric is computed only where it was actually measured.
function reconMeasured(c) {
  return typeof c.event_graph_reconstructability === "number";
}
function reconOf(c) {
  if (reconMeasured(c)) return c.event_graph_reconstructability ? 1 : 0;
  return null; // not measured -- excluded from full FFCR, never silently counted as a failure
}

// Headline metric: memory-selection accuracy (oracle set) -- every expected memory selected and
// no forbidden memory selected. This is what model_success measures; it is NOT the full FFCR.
function selectionSuccess(c) {
  return c.model_success ? 1 : 0;
}
// Full Failure-Free Completion per Section 4: selection correctness AND a reconstructable decision.
// Returns null when reconstructability was not measured for this case (excluded from the aggregate).
function ffcrSuccess(c) {
  if (!reconMeasured(c)) return null;
  return c.model_success && reconOf(c) === 1 ? 1 : 0;
}
// Full-FFCR rate over only the cases where reconstructability was measured (null if none measured).
function measuredFullRate(cases, condition) {
  const subset = cases.filter((c) => c.condition === condition && !c.api_error && reconMeasured(c));
  if (subset.length === 0) return null;
  return subset.reduce((s, c) => s + ffcrSuccess(c), 0) / subset.length;
}

function rateOf(cases, condition, scoreFn) {
  const subset = cases.filter((c) => c.condition === condition && !c.api_error);
  if (subset.length === 0) return null;
  const succ = subset.reduce((s, c) => s + scoreFn(c), 0);
  return succ / subset.length;
}
// Best baseline is chosen by the headline metric (selection accuracy).
function ffcrOf(cases, condition) {
  return rateOf(cases, condition, selectionSuccess);
}

// Build paired units of (treatment, best-baseline) per scenario family.
function bestBaselinePairs(cases, baselineConditions) {
  const families = [...new Set(cases.map(familyOf))];
  const pairs = [];
  const chosenByFamily = {};
  for (const fam of families) {
    const famCases = cases.filter((c) => familyOf(c) === fam);
    // Choose the best conventional baseline for this family. Tie-safe & conservative (review M2):
    // maximize selection accuracy first; break ties by the HIGHEST measured full-FFCR (most
    // auditable) baseline, never the first-listed one. Without this, several baselines tie at 100%
    // selection and the first (ungated C4, recon=0) was picked, manufacturing a full-FFCR gap.
    let best = null;
    for (const cond of baselineConditions) {
      const sel = ffcrOf(famCases, cond);
      if (sel === null) continue;
      const full = measuredFullRate(famCases, cond) ?? 0;
      if (best === null
          || sel > best.sel + 1e-9
          || (Math.abs(sel - best.sel) <= 1e-9 && full > best.full + 1e-9)) {
        best = { cond, sel, full, ffcr: sel };
      }
    }
    if (!best) continue;
    chosenByFamily[fam] = best.cond;
    // pair treatment vs chosen baseline on scenario_id+run_index+model
    const byKey = new Map();
    for (const c of famCases) {
      if (c.api_error) continue;
      if (c.condition !== TREATMENT && c.condition !== best.cond) continue;
      const key = `${c.model}::${c.scenario_id}::${c.run_index}`;
      if (!byKey.has(key)) byKey.set(key, {});
      const slot = byKey.get(key);
      const side = c.condition === TREATMENT ? "t" : "b";
      slot[side] = selectionSuccess(c);
      slot[`${side}f`] = ffcrSuccess(c);
    }
    for (const [, rec] of byKey) {
      if (rec.t === undefined || rec.b === undefined) continue;
      pairs.push({
        baseline: rec.b,
        treatment: rec.t,
        baseline_ffcr_full: rec.bf,
        treatment_ffcr_full: rec.tf,
        family: fam,
      });
    }
  }
  return { pairs, chosenByFamily };
}

function loadCases(sources) {
  const all = [];
  for (const src of sources) {
    const raw = readJsonIfExists(src);
    if (!raw) return null;
    if (Array.isArray(raw.cases)) all.push(...raw.cases);
  }
  return all;
}

function analyzeRow(row) {
  const cases = loadCases(row.sources);
  if (!cases) {
    return { ...rowMeta(row), status: "pending", reason: "source result file(s) not found" };
  }
  const { pairs, chosenByFamily } = bestBaselinePairs(cases, row.baselineConditions);
  if (pairs.length === 0) {
    return { ...rowMeta(row), status: "pending", reason: "no paired units in source" };
  }
  const boot = bootstrapPairedDelta(pairs, { iterations: 10000, seed: row.seed });
  // Secondary: full FFCR (selection AND reconstructability), same chosen baseline and pairing. Only
  // pairs where BOTH arms recorded reconstructability are included (review M4: never code missing as 0).
  const ffcrPairs = pairs
    .filter((p2) => p2.baseline_ffcr_full !== null && p2.treatment_ffcr_full !== null)
    .map((p2) => ({ baseline: p2.baseline_ffcr_full, treatment: p2.treatment_ffcr_full, family: p2.family }));
  const bootFull = ffcrPairs.length > 0
    ? bootstrapPairedDelta(ffcrPairs, { iterations: 10000, seed: row.seed + 1 })
    : null;
  const mc = mcnemar(pairs);
  // approximate two-sided p from chi-square(1): survival at stat
  const p = chiSqSurvival1(mc.statistic);
  // family win/tie share
  const fams = [...new Set(pairs.map((p2) => p2.family))];
  let winTie = 0;
  for (const fam of fams) {
    const fp = pairs.filter((p2) => p2.family === fam);
    const tb = fp.reduce((s, x) => s + x.treatment, 0) / fp.length;
    const bb = fp.reduce((s, x) => s + x.baseline, 0) / fp.length;
    if (tb >= bb) winTie += 1;
  }
  return {
    ...rowMeta(row),
    status: "ready",
    paired_n: boot.n,
    // Headline metric = memory-selection accuracy (oracle set). Field names kept for figure
    // compatibility; *_selection_accuracy aliases below name the construct explicitly.
    baseline_ffcr: round(boot.baseFFCR),
    treatment_ffcr: round(boot.treatFFCR),
    ffcr_delta: round(boot.delta),
    baseline_selection_accuracy: round(boot.baseFFCR),
    treatment_selection_accuracy: round(boot.treatFFCR),
    selection_accuracy_delta: round(boot.delta),
    // Secondary metric = full Failure-Free Completion Rate (Section 4: selection ∧ recon). Null when
    // this row's runner does not record reconstructability (review M4): not measured ≠ failure.
    ffcr_full_measured: bootFull !== null,
    ffcr_full_n: ffcrPairs.length,
    baseline_ffcr_full: bootFull ? round(bootFull.baseFFCR) : null,
    treatment_ffcr_full: bootFull ? round(bootFull.treatFFCR) : null,
    ffcr_full_delta: bootFull ? round(bootFull.delta) : null,
    ffcr_full_ci95: bootFull ? [round(bootFull.ci95[0]), round(bootFull.ci95[1])] : null,
    ci95: [round(boot.ci95[0]), round(boot.ci95[1])],
    significant_after_correction: boot.ci95[0] > 0,
    mcnemar_statistic: round(mc.statistic),
    mcnemar_p: round(p, 6),
    discordant_pairs: mc.discordant,
    families: fams.length,
    family_win_tie: winTie,
    family_win_tie_rate: round(winTie / Math.max(1, fams.length)),
    chosen_baseline_by_family: chosenByFamily,
    pairs, // retained for aggregate pooling; stripped from CSV
  };
}

function rowMeta(row) {
  return {
    id: row.id,
    label: row.label,
    experiment: row.experiment,
    best_baseline_label: row.baselineLabel,
    sources: row.sources,
  };
}

function round(x, d = 4) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

// chi-square survival function for df=1 via erfc.
function chiSqSurvival1(x) {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}
function erfc(x) {
  // Abramowitz-Stegun 7.1.26
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = x >= 0 ? y : -y;
  return 1 - erf;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outJson = args.json || "results/eval/best-baseline-analysis.json";
  const outCsv = args.csv || "results/eval/best-baseline-analysis.csv";

  const rows = ROWS.map(analyzeRow);

  // Holm-Bonferroni step-down across the per-experiment hypotheses (review M7: actually implement the
  // correction the paper claims, rather than only gating on a CI). Each ready row contributes its
  // McNemar p; we annotate every row with its Holm-adjusted p and rejection, and require BOTH the
  // cluster-CI lower bound > 0 AND Holm rejection for `significant_after_correction`.
  const holm = holmBonferroni(
    rows.filter((r) => r.status === "ready" && typeof r.mcnemar_p === "number")
      .map((r) => ({ key: r.id, p: r.mcnemar_p })),
    0.05,
  );
  for (const r of rows) {
    if (r.status !== "ready") continue;
    const h = holm.get(r.id);
    r.holm_adjusted_p = h ? round(h.adjusted_p ?? 1, 6) : null;
    r.holm_reject = h ? h.reject : false;
    r.significant_after_correction = (r.ci95?.[0] > 0) && r.holm_reject;
  }

  // Aggregate (E6): pool all paired units from ready rows.
  const pooled = [];
  for (const r of rows) {
    if (r.status === "ready" && Array.isArray(r.pairs)) {
      // Cluster by TRUE scenario family, NOT experiment:family (review RG9). The same underlying
      // family (e.g. twin_run) recurs across E1/E2/E5; keying clusters by experiment:family would
      // treat those correlated units as independent and over-count clusters / understate the CI.
      // The cluster bootstrap and leave-one-family-out below now resample whole families across all
      // experiments, so leave-one-family-out is a genuine leave-a-failure-mode-out test.
      for (const p of r.pairs) pooled.push({ ...p, experiment: r.id, family: p.family });
    }
  }
  let aggregate;
  if (pooled.length > 0) {
    const boot = bootstrapPairedDelta(pooled, { iterations: 10000, seed: 2706 });
    // Full FFCR pooled over ONLY the pairs whose runner recorded reconstructability (review M4):
    // E3/E5/E7 do not record it, so they are excluded rather than coded as failures, and the
    // aggregate is no longer a mix of measured and unmeasured runners.
    const pooledFull = pooled
      .filter((p) => p.baseline_ffcr_full !== null && p.treatment_ffcr_full !== null)
      .map((p) => ({ baseline: p.baseline_ffcr_full, treatment: p.treatment_ffcr_full, family: p.family }));
    const bootFull = pooledFull.length > 0 ? bootstrapPairedDelta(pooledFull, { iterations: 10000, seed: 2709 }) : null;
    // Cluster (family) bootstrap + leave-one-family-out: honest CIs that treat each scenario family
    // as the resampling unit rather than its correlated per-variant pseudo-replicates (reviewer A3).
    const clusterBoot = bootstrapClusteredPairedDelta(pooled, { iterations: 10000, seed: 2710 });
    const clusterBootFull = pooledFull.length > 0 ? bootstrapClusteredPairedDelta(pooledFull, { iterations: 10000, seed: 2711 }) : null;
    const lofo = leaveOneClusterOut(pooled);
    const fams = [...new Set(pooled.map((p) => p.family))];
    let winTie = 0;
    let maxFamShare = 0;
    let maxFamName = null;
    const totalGain = boot.delta * boot.n;
    for (const fam of fams) {
      const fp = pooled.filter((p) => p.family === fam);
      const tb = fp.reduce((s, x) => s + x.treatment, 0) / fp.length;
      const bb = fp.reduce((s, x) => s + x.baseline, 0) / fp.length;
      if (tb >= bb) winTie += 1;
      const famGain = (tb - bb) * fp.length;
      if (totalGain > 0 && famGain / totalGain > maxFamShare) { maxFamShare = famGain / totalGain; maxFamName = fam; }
    }
    aggregate = {
      id: "aggregate",
      label: "aggregate (E6)",
      experiment: "E6",
      best_baseline_label: "per-family best non-C5 baseline (ungated C4 on treatment-aligned families E1/E2/E3; best strong/oracle baseline on E5/E7)",
      status: "ready",
      paired_n: boot.n,
      baseline_ffcr: round(boot.baseFFCR),
      treatment_ffcr: round(boot.treatFFCR),
      ffcr_delta: round(boot.delta),
      baseline_selection_accuracy: round(boot.baseFFCR),
      treatment_selection_accuracy: round(boot.treatFFCR),
      selection_accuracy_delta: round(boot.delta),
      ffcr_full_measured: bootFull !== null,
      ffcr_full_n: pooledFull.length,
      baseline_ffcr_full: bootFull ? round(bootFull.baseFFCR) : null,
      treatment_ffcr_full: bootFull ? round(bootFull.treatFFCR) : null,
      ffcr_full_delta: bootFull ? round(bootFull.delta) : null,
      ffcr_full_ci95: bootFull ? [round(bootFull.ci95[0]), round(bootFull.ci95[1])] : null,
      ci95: [round(boot.ci95[0]), round(boot.ci95[1])],
      // Cluster (family) bootstrap CIs and leave-one-family-out range (reviewer A3: pseudo-replication).
      cluster_count: clusterBoot.clusters,
      cluster_ci95: [round(clusterBoot.ci95[0]), round(clusterBoot.ci95[1])],
      ffcr_full_cluster_ci95: clusterBootFull ? [round(clusterBootFull.ci95[0]), round(clusterBootFull.ci95[1])] : null,
      leave_one_family_out: { min: round(lofo.min), max: round(lofo.max), all_positive: lofo.all_positive },
      cluster_significant: clusterBoot.ci95[0] > 0,
      significant_after_correction: boot.ci95[0] > 0 && clusterBoot.ci95[0] > 0,
      families: fams.length,
      family_win_tie: winTie,
      family_win_tie_rate: round(winTie / Math.max(1, fams.length)),
      max_single_family_gain_share: round(maxFamShare),
      max_single_family_gain_name: maxFamName,
    };
  } else {
    aggregate = { id: "aggregate", label: "aggregate (E6)", experiment: "E6", status: "pending" };
  }

  const out = {
    generated_at: isoStamp(args),
    script: "scripts/analyze_sota_best_baseline.mjs",
    treatment: "MBM-Core (C5)",
    headline_metric: "Memory-Selection Accuracy (oracle set: all expected selected, no forbidden selected)",
    secondary_metric: "Failure-Free Completion Rate (FFCR) = selection accuracy AND reconstructable decision (Section 4 conjunction)",
    // `metric` retained for backward compatibility; it reports the headline selection-accuracy
    // construct (see headline_metric). Earlier revisions mislabeled this field as FFCR.
    metric: "Memory-Selection Accuracy (oracle set)",
    bootstrap_iterations: 10000,
    // Self-describe the inference so the paper and artifact agree (review S1). The Holm-Bonferroni
    // step-down is applied across the PER-EXPERIMENT hypotheses (E1,E2,E3,E5,E7), NOT across scenario
    // families; the pooled aggregate (E6) is a separate estimate whose significance rule is the
    // family-cluster bootstrap lower bound > 0 (reported as cluster_significant), conjoined with the
    // instance-bootstrap lower bound for significant_after_correction.
    inference: {
      holm_correction_unit: "per-experiment hypotheses (E1,E2,E3,E5,E7)",
      per_row_significance_rule: "instance-bootstrap CI lower > 0 AND Holm-adjusted reject",
      aggregate_significance_rule: "instance-bootstrap CI lower > 0 AND family-cluster bootstrap CI lower > 0",
    },
    rows: rows.map(stripPairs),
    aggregate,
  };
  writeJson(outJson, out);

  // CSV (without pair arrays)
  const headers = [
    "id", "experiment", "label", "status", "paired_n",
    "baseline_ffcr", "treatment_ffcr", "ffcr_delta", "ci95_low", "ci95_high",
    "significant_after_correction", "family_win_tie_rate", "best_baseline_label",
  ];
  const lines = [headers.join(",")];
  for (const r of [...rows, aggregate]) {
    lines.push([
      r.id, r.experiment ?? "", csv(r.label), r.status, r.paired_n ?? "",
      r.baseline_ffcr ?? "", r.treatment_ffcr ?? "", r.ffcr_delta ?? "",
      r.ci95?.[0] ?? "", r.ci95?.[1] ?? "",
      r.significant_after_correction ?? "", r.family_win_tie_rate ?? "",
      csv(r.best_baseline_label ?? ""),
    ].join(","));
  }
  writeText(outCsv, `${lines.join("\n")}\n`);

  const ready = rows.filter((r) => r.status === "ready").length;
  process.stdout.write(`[best-baseline] ${ready}/${rows.length} rows ready; aggregate=${aggregate.status}`);
  if (aggregate.status === "ready") {
    process.stdout.write(` delta=${aggregate.ffcr_delta} CI[${aggregate.ci95[0]},${aggregate.ci95[1]}] n=${aggregate.paired_n}`);
  }
  process.stdout.write("\n");
}

function stripPairs(r) {
  const { pairs, ...rest } = r;
  return rest;
}
function csv(s) {
  const str = String(s ?? "");
  return /[",\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}

main();
