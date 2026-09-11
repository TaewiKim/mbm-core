// E12 analyzer: cost-reliability Pareto from the stress sweep (E10).
// Prompt-token cost is ESTIMATED from the candidate-set size each condition sends to the model
// (ACM-CP gates to a small bound set; static-filter / scoped baselines forward the flooded pool).
// Emits results/eval/cost-pareto-analysis.json (consumed by Fig.4 Panel C).
import { isoStamp, parseArgs, readJsonIfExists, writeJson } from "./eval_lib.mjs";

const OVERHEAD_CHARS = 420;   // instructions + condition spec + query + active message
const PER_CAND_CHARS = 92;    // memory id + content per candidate
const CHARS_PER_TOKEN = 4;

const LABELS = {
  "C5": "MBM-Core",
  "C4+all-static-filters": "C4+all-static-filters",
  "C4": "C4 (scoped memory)",
};
const ORDER = ["C5", "C4+all-static-filters", "C4"];

function estTokens(candidateCount) {
  return Math.round((OVERHEAD_CHARS + candidateCount * PER_CAND_CHARS) / CHARS_PER_TOKEN);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.result || "results/eval/e10-stress-gpt54nano.json";
  const out = args.json || "results/eval/cost-pareto-analysis.json";
  const j = readJsonIfExists(input);
  if (!j) { process.stdout.write(`[e12] ${input} not found\n`); process.exit(0); }

  const points = ORDER.filter((cond) => j.cases.some((c) => c.condition === cond)).map((cond) => {
    const items = j.cases.filter((c) => c.condition === cond && !c.api_error);
    const meanCands = items.reduce((s, c) => s + (c.candidate_count ?? 0), 0) / Math.max(1, items.length);
    const ffcr = items.filter((c) => c.model_success).length / Math.max(1, items.length);
    return {
      id: cond === "C5" ? "acmcp-core" : cond,
      label: LABELS[cond] ?? cond,
      cost: estTokens(meanCands),
      mean_candidates: Number(meanCands.toFixed(1)),
      ffcr: Number(ffcr.toFixed(4)),
    };
  });

  const analysis = {
    generated_at: isoStamp(args),
    script: "scripts/analyze_cost_pareto.mjs",
    source: input,
    model: j.model,
    cost_model: { overhead_chars: OVERHEAD_CHARS, per_candidate_chars: PER_CAND_CHARS, chars_per_token: CHARS_PER_TOKEN, note: "prompt tokens estimated from candidate-set size under the stress sweep; not metered API tokens" },
    x_label: "prompt tokens (est.)",
    points,
  };
  writeJson(out, analysis);
  process.stdout.write(`[e12] ${points.length} Pareto points -> ${out}\n`);
  for (const p of points) process.stdout.write(`  ${p.label.padEnd(24)} cost~${p.cost} tok  ffcr=${p.ffcr}  (mean cands ${p.mean_candidates})\n`);
}

main();
