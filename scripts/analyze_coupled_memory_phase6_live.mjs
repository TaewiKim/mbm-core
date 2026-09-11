import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pairedRows(cases) {
  const byKey = new Map();
  for (const item of cases) {
    const key = `${item.model ?? "unknown-model"}:${item.scenario_id}:${item.run_index}`;
    if (!byKey.has(key)) {
      byKey.set(key, {});
    }
    byKey.get(key)[item.condition] = item;
  }
  return [...byKey.entries()]
    .filter(([, value]) => value.C4 && value.C5)
    .map(([key, value]) => ({
      key,
      c4: value.C4,
      c5: value.C5,
      delta: Number(Boolean(value.C5.model_success)) - Number(Boolean(value.C4.model_success)),
      forbidden_delta: Number(value.C4.selected_forbidden_memory ?? 0) - Number(value.C5.selected_forbidden_memory ?? 0),
    }));
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function bootstrap(rows, field, iterations, seed) {
  const rng = makeRng(seed);
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    for (let j = 0; j < rows.length; j += 1) {
      total += rows[Math.floor(rng() * rows.length)][field];
    }
    means.push(total / rows.length);
  }
  return {
    mean: rows.reduce((total, item) => total + item[field], 0) / rows.length,
    ci95: [quantile(means, 0.025), quantile(means, 0.975)],
  };
}

export function analyzeCoupledMemoryPhase6Live(result, { iterations = 5000, seed = 2606 } = {}) {
  const rows = pairedRows(result.cases ?? []);
  const success = bootstrap(rows, "delta", iterations, seed);
  const forbidden = bootstrap(rows, "forbidden_delta", iterations, seed + 1);
  const c4 = rows.map((row) => row.c4);
  const c5 = rows.map((row) => row.c5);
  return {
    input: result.benchmark,
    model: result.model,
    paired_n: rows.length,
    bootstrap_iterations: iterations,
    seed,
    c4_successes: c4.filter((item) => item.model_success).length,
    c4_cases: c4.length,
    c5_successes: c5.filter((item) => item.model_success).length,
    c5_cases: c5.length,
    c4_forbidden_memory: c4.reduce((total, item) => total + Number(item.selected_forbidden_memory ?? 0), 0),
    c5_forbidden_memory: c5.reduce((total, item) => total + Number(item.selected_forbidden_memory ?? 0), 0),
    paired_success_delta: success.mean,
    paired_success_delta_ci95: success.ci95,
    paired_forbidden_memory_delta: forbidden.mean,
    paired_forbidden_memory_delta_ci95: forbidden.ci95,
  };
}

function markdown(analysis, input) {
  return [
    "# Coupled-Memory Phase 6 Live Analysis",
    "",
    `Input: \`${input}\``,
    `Model: \`${analysis.model}\``,
    "",
    "## Paired Results",
    "",
    `- Paired cases: ${analysis.paired_n}`,
    `- C5 successes: ${analysis.c5_successes}/${analysis.c5_cases}`,
    `- C4 successes: ${analysis.c4_successes}/${analysis.c4_cases}`,
    `- C4 forbidden-memory selections: ${analysis.c4_forbidden_memory}`,
    `- C5 forbidden-memory selections: ${analysis.c5_forbidden_memory}`,
    "",
    "## Effect Sizes",
    "",
    `- Success delta, C5-C4: ${analysis.paired_success_delta.toFixed(4)}`,
    `- Success delta 95% bootstrap CI: [${analysis.paired_success_delta_ci95.map((item) => item.toFixed(4)).join(", ")}]`,
    `- Forbidden-memory reduction, C4-C5: ${analysis.paired_forbidden_memory_delta.toFixed(4)}`,
    `- Forbidden-memory reduction 95% bootstrap CI: [${analysis.paired_forbidden_memory_delta_ci95.map((item) => item.toFixed(4)).join(", ")}]`,
    "",
  ].join("\n");
}

const parsed = parseArgs({
  options: {
    result: { type: "string", default: "results/coupled-memory-phase6-live-dev24-gpt5nano.json" },
    json: { type: "string", default: "results/coupled-memory-phase6-live-dev24-gpt5nano-analysis.json" },
    md: { type: "string", default: "results/coupled-memory-phase6-live-dev24-gpt5nano-analysis.md" },
    bootstrap: { type: "string", default: "5000" },
    seed: { type: "string", default: "2606" },
  },
});

const result = JSON.parse(readFileSync(parsed.values.result, "utf8"));
const analysis = analyzeCoupledMemoryPhase6Live(result, {
  iterations: Number.parseInt(parsed.values.bootstrap, 10),
  seed: Number.parseInt(parsed.values.seed, 10),
});
mkdirSync(dirname(parsed.values.json), { recursive: true });
writeFileSync(parsed.values.json, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
writeFileSync(parsed.values.md, `${markdown(analysis, parsed.values.result)}\n`, "utf8");
console.log(`Wrote ${parsed.values.json}`);
console.log(`Wrote ${parsed.values.md}`);
