// Analyzes E18 long-running multi-agent workflow benchmark: paired C4 vs C5 end-to-end success.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { bootstrapPairedDelta, mcnemar, mean } from "./eval_lib.mjs";

// combine all model files (nano + mini) for a 2-model result; pair within (model, episode).
const paths = process.argv.slice(2);
const files = paths.length ? paths
  : ["results/eval/e18-longrun.jsonl", "results/eval/e18-longrun-mini.jsonl"].filter((f) => existsSync(f));
const rows = files.flatMap((p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => !r.api_error && r.end_to_end_success !== undefined);

const byKey = new Map();
for (const r of rows) {
  const k = `${r.model}|${r.episode_id}`;
  const e = byKey.get(k) || { domain: r.domain, model: r.model };
  e[r.condition] = r.end_to_end_success ? 1 : 0;
  e[`${r.condition}_contam`] = r.contaminated ? 1 : 0;
  byKey.set(k, e);
}
const entries = [...byKey.values()].filter((e) => e.C4 != null && e.C5 != null);
const pairs = entries.map((e) => ({ baseline: e.C4, treatment: e.C5 }));
const bs = bootstrapPairedDelta(pairs, { iterations: 10000, seed: 2606 });

// Honest coverage accounting (review M7): distinguish UNIQUE episodes and failure families from the
// model-episode UNITS. n_episodes (units) = unique_episodes x models; do not report units as episodes
// nor families as more than were actually run live.
const uniqueEpisodes = new Set(rows.map((r) => r.episode_id)).size;
const families = new Set(rows.map((r) => r.domain ?? r.family ?? r.episode_id)).size;
const modelCount = new Set(rows.map((r) => r.model)).size;

const out = {
  experiment: "E18",
  benchmark: "Long-running multi-agent workflow (multi-turn, multiple agent roles, shared accumulating memory, mid-workflow contamination)",
  metric: "end-to-end workflow success (final answer correct AND no turn acted on a contaminating record)",
  unique_episodes: uniqueEpisodes,
  families,
  models: modelCount,
  model_episode_units: entries.length,
  n_episodes: entries.length,
  c4_success: Number(bs.baseFFCR.toFixed(4)),
  c5_success: Number(bs.treatFFCR.toFixed(4)),
  delta: Number(bs.delta.toFixed(4)),
  ci95: bs.ci95.map((x) => Number(x.toFixed(4))),
  mcnemar: mcnemar(pairs),
  c4_contamination_rate: Number(mean(entries.map((e) => e.C4_contam || 0)).toFixed(4)),
  c5_contamination_rate: Number(mean(entries.map((e) => e.C5_contam || 0)).toFixed(4)),
};
const models = [...new Set(entries.map((e) => e.model))];
out.by_model = Object.fromEntries(models.map((m) => {
  const es = entries.filter((e) => e.model === m);
  return [m, {
    n: es.length,
    c4_success: Number(mean(es.map((e) => e.C4)).toFixed(4)),
    c5_success: Number(mean(es.map((e) => e.C5)).toFixed(4)),
    c4_contamination_rate: Number(mean(es.map((e) => e.C4_contam || 0)).toFixed(4)),
    c5_contamination_rate: Number(mean(es.map((e) => e.C5_contam || 0)).toFixed(4)),
  }];
}));
out.go = out.ci95[0] > 0;
out.verdict = out.go
  ? `GO: across long-running multi-agent workflows, message-bound memory raises end-to-end success ${out.c4_success}->${out.c5_success} (delta ${out.delta} [${out.ci95}]); mid-workflow contamination ${out.c4_contamination_rate}->${out.c5_contamination_rate}.`
  : `NULL/NEG: delta ${out.delta} [${out.ci95}] -- report honestly.`;
writeFileSync("results/eval/e18-longrun-analysis.json", JSON.stringify(out, null, 2) + "\n");
console.log(out.verdict);
console.log("n=", out.n_episodes, "C4=", out.c4_success, "C5=", out.c5_success, "contam C4=", out.c4_contamination_rate, "C5=", out.c5_contamination_rate);
