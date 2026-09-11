// Analyzes E17 live multi-agent LangGraph: paired C4 vs C5 task success on SE-native cases.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { bootstrapPairedDelta, mcnemar, mean } from "./eval_lib.mjs";

const paths = process.argv.slice(2);
const files = paths.length ? paths
  : ["results/eval/e17-langgraph-live.jsonl", "results/eval/e17-langgraph-live-mini.jsonl"].filter((f) => existsSync(f));
const rows = files.flatMap((p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => !r.api_error && r.model_success !== null);

const byKey = new Map();
for (const r of rows) {
  const k = `${r.model}|${r.scenario_id}`;
  const e = byKey.get(k) || {};
  e[r.condition] = r.model_success ? 1 : 0;
  byKey.set(k, e);
}
const pairs = [...byKey.values()].filter((e) => e.C4 != null && e.C5 != null)
  .map((e) => ({ baseline: e.C4, treatment: e.C5 }));
const bs = bootstrapPairedDelta(pairs, { iterations: 10000, seed: 2606 });

const out = {
  experiment: "E17", harness: "LangGraph (live multi-agent: writer nodes + gate + live LLM executor, shared MemorySaver store)",
  dataset: "SE-native (public-repo-derived)", metric: "multi-agent task success (selected expected, no forbidden)",
  n_pairs: pairs.length,
  c4_success: Number(bs.baseFFCR.toFixed(4)),
  c5_success: Number(bs.treatFFCR.toFixed(4)),
  delta: Number(bs.delta.toFixed(4)),
  ci95: bs.ci95.map((x) => Number(x.toFixed(4))),
  mcnemar: mcnemar(pairs),
};
out.go = out.ci95[0] > 0;
out.verdict = out.go
  ? `GO: in a LIVE multi-agent LangGraph workflow, the message-bound gate raises task success from ${out.c4_success} (C4) to ${out.c5_success} (C5), delta ${out.delta} [${out.ci95}]. The protocol improves performance in the setting it targets.`
  : `NULL/NEG: delta ${out.delta} [${out.ci95}] -- report honestly.`;
writeFileSync("results/eval/e17-langgraph-live-analysis.json", JSON.stringify(out, null, 2) + "\n");
console.log(out.verdict);
console.log("n=", out.n_pairs, "C4=", out.c4_success, "C5=", out.c5_success, "mcnemar=", JSON.stringify(out.mcnemar));
