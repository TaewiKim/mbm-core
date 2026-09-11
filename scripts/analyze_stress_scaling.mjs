// E10 analyzer: compute FFCR vs distractor-memory pressure per condition and emit
// results/eval/stress-scaling-analysis.json (consumed by Fig.4 Panel B).
import { isoStamp, parseArgs, readJsonIfExists, writeJson } from "./eval_lib.mjs";

const LABELS = {
  "C5": "MBM-Core",
  "C4+all-static-filters": "C4+all-static-filters",
  "C4": "C4 (scoped memory)",
};
const ORDER = ["C5", "C4+all-static-filters", "C4"];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.result || "results/eval/e10-stress-gpt54nano.json";
  const out = args.json || "results/eval/stress-scaling-analysis.json";
  const j = readJsonIfExists(input);
  if (!j) { process.stdout.write(`[e10] ${input} not found\n`); process.exit(0); }

  const levels = j.distractor_levels ?? [...new Set(j.cases.map((c) => c.distractors))].sort((a, b) => a - b);
  const series = ORDER.filter((cond) => j.cases.some((c) => c.condition === cond)).map((cond) => {
    const ffcr = levels.map((k) => {
      const items = j.cases.filter((c) => c.condition === cond && c.distractors === k && !c.api_error);
      if (items.length === 0) return null;
      return Number((items.filter((c) => c.model_success).length / items.length).toFixed(4));
    });
    return { label: LABELS[cond] ?? cond, condition: cond, ffcr };
  });

  const analysis = {
    generated_at: isoStamp(args),
    script: "scripts/analyze_stress_scaling.mjs",
    source: input,
    model: j.model,
    x: levels,
    x_label: "distractor memories",
    series,
  };
  writeJson(out, analysis);
  process.stdout.write(`[e10] ${series.length} series over distractors [${levels.join(",")}] -> ${out}\n`);
  for (const s of series) process.stdout.write(`  ${s.label.padEnd(24)} ${s.ffcr.join("  ")}\n`);
}

main();
