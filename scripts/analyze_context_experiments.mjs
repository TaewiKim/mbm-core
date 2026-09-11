// E4 (protocol-family matched-transcript) and E11 (native-framework integration) CONTEXTUAL
// analyses. These are explicitly contextual: ACM-CP has the strongest reliability envelope among
// the evaluated protocol-family baselines under a matched transcript runner, and the gate
// integrates into representative frameworks. We do NOT claim ACM-CP beats those systems in their
// native implementations.
import { isoStamp, parseArgs, readJsonIfExists, writeJson } from "./eval_lib.mjs";

function e4() {
  const a = readJsonIfExists("results/sota-frontier-live-acmcp-core-analysis-seed2030-tls0.json");
  if (!a) return null;
  const rows = a.contrasts.filter((c) => c.metric === "success").map((c) => ({
    baseline: c.control.protocol,
    acmcp_success: c.treatment.mean,
    baseline_success: c.control.mean,
    delta: c.delta,
    ci95: [c.bootstrap_ci_95.low, c.bootstrap_ci_95.high],
    paired_n: c.paired_n,
  }));
  return {
    experiment: "E4",
    title: "Protocol-family matched-transcript comparison (contextual)",
    runner: "matched transcript",
    model: a.model,
    health: a.health,
    claim: "ACM-CP has the strongest reliability envelope on communication-memory failure modes among the evaluated protocol-family baselines under a matched transcript runner.",
    not_claim: "ACM-CP beats A2A/AutoGen/MPAC/Mesh/Q-KVComm in their native implementations.",
    rows,
  };
}

function e11() {
  const lg = readJsonIfExists("results/coupled-memory-phase5-langgraph-native-check.json");
  const ag = readJsonIfExists("results/coupled-memory-phase5-autogen-native-check.json");
  const frameworks = [];
  if (lg?.checked) frameworks.push({
    framework: "LangGraph", adapter: lg.checked.adapter_status,
    c5_successes: lg.checked.c5_successes, c5_cases: lg.checked.c5_cases,
    c4_failures: lg.checked.c4_failures, c4_cases: lg.checked.c4_cases,
    status: lg.status,
  });
  if (ag?.checked) frameworks.push({
    framework: "AutoGen", adapter: ag.checked.adapter_status,
    version: ag.checked.autogen_agentchat,
    c5_successes: ag.checked.c5_successes, c5_cases: ag.checked.c5_cases,
    c4_failures: ag.checked.c4_failures, c4_cases: ag.checked.c4_cases,
    status: ag.status,
  });
  if (frameworks.length === 0) return null;
  return {
    experiment: "E11",
    title: "Native-framework integration (contextual)",
    claim: "The message-bound gate integrates into representative agent frameworks as a wrapper around their communication/memory interfaces; C5 succeeds on scenarios where C4 fails.",
    not_claim: "ACM-CP beats LangGraph or AutoGen.",
    frameworks,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const e4out = e4();
  const e11out = e11();
  if (e4out) {
    writeJson("results/eval/e4-protocol-family-analysis.json", { generated_at: isoStamp(args), script: "scripts/analyze_context_experiments.mjs", ...e4out });
    process.stdout.write(`[e4] ${e4out.rows.length} protocol-family contrasts (model ${e4out.model})\n`);
    for (const r of e4out.rows) process.stdout.write(`  acmcp-core vs ${r.baseline.padEnd(22)} delta=${r.delta} CI[${r.ci95[0]},${r.ci95[1]}]\n`);
  }
  if (e11out) {
    writeJson("results/eval/native-framework-integration.json", { generated_at: isoStamp(args), script: "scripts/analyze_context_experiments.mjs", ...e11out });
    process.stdout.write(`[e11] ${e11out.frameworks.length} frameworks integrated\n`);
    for (const f of e11out.frameworks) process.stdout.write(`  ${f.framework.padEnd(10)} C5 ${f.c5_successes}/${f.c5_cases}, C4 fail ${f.c4_failures}/${f.c4_cases} (${f.status})\n`);
  }
}

main();
