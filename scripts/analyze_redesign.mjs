// Analyzes E13 (blind ETC) and E14 (best-effort baselines). Paired bootstrap via eval_lib.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { bootstrapPairedDelta, mcnemar, mean } from "./eval_lib.mjs";

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---------- E13: blind ETC, C4 vs C5 ----------
function analyzeE13() {
  const rows = [...readJsonl("results/eval/e13-etc-e1.jsonl"), ...readJsonl("results/eval/e13-etc-e3.jsonl")]
    .filter((r) => r.etc_correct !== null && !r.judge_error);
  const bySource = (src) => rows.filter((r) => src === "all" || r.source === src);

  function deltas(subset) {
    // key pairs by scenario_id + run_index + subject_model
    const byKey = new Map();
    for (const r of subset) {
      const k = `${r.subject_model}|${r.scenario_id}|${r.run_index}`;
      const e = byKey.get(k) || {};
      if (r.condition === "C4") { e.c4_etc = r.etc_correct ? 1 : 0; e.c4_ffcr = r.ffcr_success ? 1 : 0; }
      if (r.condition === "C5") { e.c5_etc = r.etc_correct ? 1 : 0; e.c5_ffcr = r.ffcr_success ? 1 : 0; }
      byKey.set(k, e);
    }
    const pairs = [...byKey.values()].filter((e) => e.c4_etc != null && e.c5_etc != null);
    const etcPairs = pairs.map((p) => ({ baseline: p.c4_etc, treatment: p.c5_etc }));
    const ffcrPairs = pairs.map((p) => ({ baseline: p.c4_ffcr, treatment: p.c5_ffcr }));
    const etc = bootstrapPairedDelta(etcPairs, { iterations: 10000, seed: 2606 });
    const ffcr = bootstrapPairedDelta(ffcrPairs, { iterations: 10000, seed: 2606 });
    return {
      n_pairs: pairs.length,
      etc: { c4: Number(etc.baseFFCR.toFixed(4)), c5: Number(etc.treatFFCR.toFixed(4)), delta: Number(etc.delta.toFixed(4)), ci95: etc.ci95.map((x) => Number(x.toFixed(4))) },
      ffcr_for_reference: { c4: Number(ffcr.baseFFCR.toFixed(4)), c5: Number(ffcr.treatFFCR.toFixed(4)), delta: Number(ffcr.delta.toFixed(4)) },
      mcnemar_etc: mcnemar(etcPairs.map((p) => ({ baseline: p.baseline, treatment: p.treatment }))),
    };
  }

  const out = {
    experiment: "E13", metric: "End-Task Correctness (mechanism-blind judge)",
    threat: "T2 (FFCR presupposes the mechanism)",
    e1: deltas(bySource("e1")), e3: deltas(bySource("e3")), combined: deltas(bySource("all")),
  };
  const c = out.combined.etc;
  out.go = c.ci95[0] > 0 && Math.sign(c.delta) === Math.sign(out.combined.ffcr_for_reference.delta);
  out.verdict = out.go
    ? "GO: ETC delta CI lower bound > 0 and agrees with FFCR sign -> effect survives a mechanism-blind metric."
    : "NO-GO: effect not robust to mechanism-blind scoring -> narrow claim.";
  writeFileSync("results/eval/e13-etc-analysis.json", JSON.stringify(out, null, 2) + "\n");
  return out;
}

// ---------- E14: best-effort baselines vs deterministic gate (holdout) ----------
function analyzeE14() {
  const rows = [...readJsonl("results/eval/e14-best-effort-gpt54nano.jsonl"), ...readJsonl("results/eval/e14-best-effort-gpt54mini.jsonl")]
    .filter((r) => !r.api_error && r.model_success !== null);
  const conds = [...new Set(rows.map((r) => r.condition))];
  const perCond = {};
  for (const cond of conds) {
    const sub = rows.filter((r) => r.condition === cond);
    const ffcr = mean(sub.map((r) => (r.model_success ? 1 : 0)));
    // treatment = deterministic gate C5 = 1.0 on every holdout case (known); delta vs that
    const pairs = sub.map((r) => ({ baseline: r.model_success ? 1 : 0, treatment: 1 }));
    const bs = bootstrapPairedDelta(pairs, { iterations: 10000, seed: 2606 });
    perCond[cond] = { n: sub.length, ffcr: Number(ffcr.toFixed(4)), delta_vs_gate: Number(bs.delta.toFixed(4)), ci95: bs.ci95.map((x) => Number(x.toFixed(4))) };
  }
  const out = {
    experiment: "E14", metric: "FFCR on content-blind holdout", threat: "T4 (baselines are treatment ablations)",
    reference: "deterministic gate (C5) = 1.000 on this holdout (all 80 cases x models)",
    baselines: perCond,
  };
  const maxB = Math.max(...Object.values(perCond).map((v) => v.ffcr));
  out.go = maxB <= 0.5;
  out.verdict = out.go
    ? `GO: every best-effort non-binding baseline <= chance (max FFCR ${maxB.toFixed(2)}) while the gate holds at 1.00 -> deterministic enforcement is necessary.`
    : `PARTIAL/NO-GO: a best-effort baseline reached ${maxB.toFixed(2)} -> report honestly, restrict necessity claim.`;
  writeFileSync("results/eval/e14-best-effort-analysis.json", JSON.stringify(out, null, 2) + "\n");
  return out;
}

const which = process.argv[2] || "all";
if (which === "e13" || which === "all") console.log("E13:", JSON.stringify(analyzeE13().combined?.etc ?? analyzeE13(), null, 1));
if (which === "e14" || which === "all") console.log("E14:", JSON.stringify(analyzeE14().baselines, null, 1));
