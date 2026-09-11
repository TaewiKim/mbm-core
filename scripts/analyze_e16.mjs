// Analyzes E16 LoCoMo: native vs native+MBM answer accuracy, paired bootstrap, per-category.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { bootstrapPairedDelta, mcnemar, mean } from "./eval_lib.mjs";

const argPaths = process.argv.slice(2);
const files = argPaths.length ? argPaths
  : ["results/eval/e16-locomo.jsonl", "results/eval/e16-locomo-mini.jsonl"].filter((f) => existsSync(f));
const rows = files.flatMap((p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => !r.error && r.native_correct !== null && r.mbm_correct !== null);

function block(subset) {
  const pairs = subset.map((r) => ({ baseline: r.native_correct ? 1 : 0, treatment: r.mbm_correct ? 1 : 0 }));
  const bs = bootstrapPairedDelta(pairs, { iterations: 10000, seed: 2606 });
  return {
    n: subset.length,
    native_acc: Number(mean(subset.map((r) => (r.native_correct ? 1 : 0))).toFixed(4)),
    mbm_acc: Number(mean(subset.map((r) => (r.mbm_correct ? 1 : 0))).toFixed(4)),
    delta: Number(bs.delta.toFixed(4)),
    ci95: bs.ci95.map((x) => Number(x.toFixed(4))),
    mcnemar: mcnemar(pairs),
  };
}

const CAT = { 1: "single-hop", 2: "temporal", 3: "multi-hop", 4: "open-domain", 5: "adversarial" };
const out = {
  experiment: "E16", benchmark: "LoCoMo (Maharana et al.)", metric: "answer accuracy (native LoCoMo task)",
  conditions: "native (top-K retrieval) vs native+MBM (gate scopes candidates to the active-message entity + recency)",
  overall: block(rows),
  by_category: Object.fromEntries(Object.keys(CAT).map((c) => [CAT[c], block(rows.filter((r) => String(r.category) === c))])),
};
out.go = out.overall.ci95[0] > 0;
out.verdict = out.go
  ? `GO: MBM improves native LoCoMo accuracy by ${out.overall.delta} [${out.overall.ci95}] -- external benchmark, native metric.`
  : (out.overall.delta < 0 && out.overall.ci95[1] < 0
    ? `NEGATIVE: the gate HURTS free-form QA (delta ${out.overall.delta} [${out.overall.ci95}]). Honest scoping result: the mechanism targets agent workflows with an active-message binding context, not broad transcript QA where wide retrieval is needed.`
    : `NULL: no significant effect on LoCoMo (delta ${out.overall.delta} [${out.overall.ci95}]). The gate neither helps nor hurts free QA; rebuttal of treatment-design rests on E13/E14/E15. Scopes claim to active-message agent workflows.`);
writeFileSync("results/eval/e16-locomo-analysis.json", JSON.stringify(out, null, 2) + "\n");
console.log(out.verdict);
console.log("overall:", JSON.stringify(out.overall));
for (const [k, v] of Object.entries(out.by_category)) console.log(`  ${k}: native ${v.native_acc} mbm ${v.mbm_acc} d=${v.delta} ${JSON.stringify(v.ci95)} n=${v.n}`);
