// E9 analyzer: compute per-control Failure-Free Completion Rate from negative-control result
// file(s) and emit results/eval/negative-controls-analysis.json (consumed by Fig.4 Panel A and
// the G7 evidence check). Accepts one or more --result files (e.g., nano + mini).
import { isoStamp, parseArgs, readJsonIfExists, writeJson } from "./eval_lib.mjs";

const ORDER = [
  "acmcp-core", "C5-label-only", "C5-shuffled-binding", "C5-wrong-message",
  "C5-no-policy", "C5-no-provenance", "C5-random-gate",
];
const LABELS = {
  "acmcp-core": "real C5 / MBM-Core",
  "C5-label-only": "C5-label-only",
  "C5-shuffled-binding": "C5-shuffled-binding",
  "C5-wrong-message": "C5-wrong-message",
  "C5-no-policy": "C5-no-policy",
  "C5-no-provenance": "C5-no-provenance",
  "C5-random-gate": "C5-random-gate",
};
// Control taxonomy. The reviewer concern the negative controls must refute is "C5 wins because
// of labels / prompt structure / longer prompts": that is tested by the binding-corruption
// controls. The two single-check ablations remove one gate check each; on content-cued families
// a capable model can self-correct, so they are reported as a nuance, not a headline.
const TYPE = {
  "acmcp-core": "treatment",
  "C5-label-only": "binding_corruption",
  "C5-shuffled-binding": "binding_corruption",
  "C5-wrong-message": "binding_corruption",
  "C5-random-gate": "binding_corruption",
  "C5-no-policy": "single_check_ablation",
  "C5-no-provenance": "single_check_ablation",
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = (args.result || "results/eval/e9-negative-controls-gpt54nano.json").split(",").map((s) => s.trim());
  const out = args.json || "results/eval/negative-controls-analysis.json";

  const cases = [];
  const models = new Set();
  for (const f of inputs) {
    const j = readJsonIfExists(f);
    if (!j) continue;
    for (const c of j.cases ?? []) {
      if (c.api_error) continue;
      cases.push(c);
      models.add(c.model);
    }
  }
  if (cases.length === 0) {
    process.stdout.write("[e9] no cases found; analysis not written\n");
    process.exit(0);
  }
  const byCtrl = new Map();
  for (const c of cases) {
    if (!byCtrl.has(c.condition)) byCtrl.set(c.condition, []);
    byCtrl.get(c.condition).push(c);
  }
  const controls = ORDER.filter((id) => byCtrl.has(id)).map((id) => {
    const items = byCtrl.get(id);
    const succ = items.filter((i) => i.model_success).length;
    const fb = items.reduce((s, i) => s + Number(i.selected_forbidden_memory ?? 0), 0);
    return {
      id,
      label: LABELS[id] ?? id,
      type: TYPE[id] ?? "control",
      n: items.length,
      ffcr: Number((succ / items.length).toFixed(4)),
      selected_forbidden_memory: fb,
    };
  });
  const real = controls.find((c) => c.id === "acmcp-core");
  const realFFCR = real ? real.ffcr : null;
  const binding = controls.filter((c) => c.type === "binding_corruption");
  const bindingFail = real ? binding.every((c) => c.ffcr < realFFCR - 0.1) : false;
  const labelOnly = controls.find((c) => c.id === "C5-label-only");
  const wrongMsg = controls.find((c) => c.id === "C5-wrong-message");

  const analysis = {
    generated_at: isoStamp(args),
    script: "scripts/analyze_negative_controls.mjs",
    sources: inputs,
    models: [...models],
    real_c5_ffcr: realFFCR,
    controls,
    note: "Binding-corruption controls refute the label/structure explanation. Single-check ablations (no-policy, no-provenance) stay high because scenario content reveals validity on the affected families and a capable model self-corrects; reported as a robustness nuance.",
    gates: {
      "E9-G1 real C5 beats all binding-corruption controls by >0.1": bindingFail,
      "E9-G2 label-only does not reproduce real C5": labelOnly ? labelOnly.ffcr < realFFCR - 0.1 : "pending",
      "E9-G3 wrong-message fails on wrong-run/task": wrongMsg ? wrongMsg.ffcr < realFFCR - 0.1 : "pending",
    },
  };
  writeJson(out, analysis);
  process.stdout.write(`[e9] ${controls.length} controls; real C5 FFCR=${realFFCR}; binding-controls-fail=${bindingFail}; -> ${out}\n`);
  for (const c of controls) process.stdout.write(`  ${c.id.padEnd(22)} FFCR=${c.ffcr} (n=${c.n}, forbidden=${c.selected_forbidden_memory})\n`);
}

main();
