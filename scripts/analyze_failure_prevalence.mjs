// E15(b) — Failure prevalence (lower-bound, in-environment).
// Classifies baseline (C4) failures in existing traces by scenario family and MAST category.
// SE-native (E3) cases are derived from public GitHub repositories, so their C4 failure rate is a
// real-artifact-derived lower-bound proxy for how often communication-memory mismatch failures occur
// when the workflow is NOT authored around the mechanism. True in-the-wild prevalence needs external
// non-constructed agent traces (no internet in build env -> declared as a gap, see prereg E15).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const mast = JSON.parse(readFileSync("results/eval/mast-family-mapping.json", "utf8"));
const FAM_BY_PREFIX = mast.families.map((f) => f.family); // e.g. twin_run, pause_resume, ...
const MAST_BY_FAMILY = Object.fromEntries(mast.families.map((f) => [f.family, f.mast_category]));

function familyOf(scenarioType) {
  // E1 types look like "twin_run_shared_memory_contamination"; match the known family prefix.
  return FAM_BY_PREFIX.find((fam) => scenarioType.startsWith(fam)) || null;
}

function c4Stats(file, label, { realDerived = false } = {}) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  const c4 = (d.cases || []).filter((c) => c.condition === "C4" && !c.api_error);
  const byType = {};
  let fail = 0;
  for (const c of c4) {
    const ok = !!c.model_success;
    if (!ok) fail += 1;
    const t = c.scenario_type;
    byType[t] = byType[t] || { total: 0, fail: 0, family: familyOf(t), mast: MAST_BY_FAMILY[familyOf(t)] || null };
    byType[t].total += 1;
    if (!ok) byType[t].fail += 1;
  }
  return {
    label, file, real_derived: realDerived,
    c4_cases: c4.length,
    c4_failures: fail,
    c4_failure_rate: c4.length ? Number((fail / c4.length).toFixed(4)) : null,
    by_scenario_type: Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, {
      ...v, failure_rate: v.total ? Number((v.fail / v.total).toFixed(4)) : null,
    }])),
  };
}

const out = {
  experiment: "E15b",
  description: "Prevalence of communication-memory mismatch failures under the non-binding baseline (C4).",
  prereg_threshold: "mismatch-attributable C4 failures >= 15%",
  external_prevalence_gap: "True in-the-wild prevalence requires external non-constructed agent traces; deferred (no internet in build env). SE-native (E3) is the real-artifact-derived lower-bound proxy.",
  constructed_E1: c4Stats("results/coupled-memory-phase6-live-main40-r3-combined-2models.json", "constructed (E1)"),
  se_native_E3: c4Stats("results/eval/e3-se-native-combined.json", "SE-native / GitHub-derived (E3)", { realDerived: true }),
};
// Headline proxy: SE-native C4 failure rate (real-repo-derived) and whether it clears the prereg threshold.
out.se_native_c4_failure_rate = out.se_native_E3.c4_failure_rate;
out.passes_prereg_15pct = (out.se_native_E3.c4_failure_rate ?? 0) >= 0.15;

mkdirSync("results/eval", { recursive: true });
writeFileSync("results/eval/failure-prevalence-analysis.json", JSON.stringify(out, null, 2) + "\n");
console.log(`[E15b] SE-native C4 failure rate (real-derived proxy) = ${out.se_native_c4_failure_rate}; constructed E1 C4 failure = ${out.constructed_E1.c4_failure_rate}; passes_prereg_15pct=${out.passes_prereg_15pct}`);
