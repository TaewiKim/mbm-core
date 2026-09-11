#!/usr/bin/env node
// Combined-baseline residual-gap check (reviewer response: "MBM only blocks two attacks beyond a
// strong combined baseline"). Deterministic, no API. Runs the Phase-4 main suite (180 cases) under:
//
//   * C5                              -- the full active-message MBM gate (treatment).
//   * C4+combined-causal              -- the union of ALL deployable access-control paradigms WITH
//                                        recomputed causal reachability (= MBM's per-record gate).
//   * C4+combined-conventional-exists -- the same maximal union but with referential-integrity
//                                        provenance instead of recomputed reachability (what real
//                                        ABAC+ReBAC+capability systems actually express).
//
// Asserts and documents the honest residual gap:
//   (1) C5 mediates all 180.
//   (2) combined-causal TIES C5 (180/180): the only way a combined baseline reaches MBM's per-record
//       coverage is to adopt MBM's recomputed-reachability predicate.
//   (3) combined-conventional-exists is < 180 and is defeated specifically by the graph-only
//       sibling-branch family (0/20): referential integrity is not recomputed causal reachability.
//
// The two irreducible advantages MBM retains over EVEN the combined-causal baseline are on different
// axes and are evaluated elsewhere (not access-control predicates): P8 integrity flow (S4 integrity
// set) and set-level non-compositionality on a true merge (Proposition 1, Table IV).
//
// Emits results/combined-baseline-residual.json and results/latex/generated_combined_macros.tex.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PHASE4_MAIN_SCENARIOS, runPhase4ScenarioBaseline } from "../benchmarks/coupled_memory/scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const TREATMENT = "C5";
const COMBINED_CAUSAL = "C4+combined-causal";
const COMBINED_EXISTS = "C4+combined-conventional-exists";
const SIBLING_FAMILY = "graph_only_sibling_branch_provenance";
const CONDS = [TREATMENT, COMBINED_CAUSAL, COMBINED_EXISTS];

function evaluate() {
  const byType = new Map();
  for (const scenario of PHASE4_MAIN_SCENARIOS) {
    const t = scenario.scenario_type;
    if (!byType.has(t)) byType.set(t, { total: 0, pass: Object.fromEntries(CONDS.map((c) => [c, 0])) });
    const e = byType.get(t);
    e.total += 1;
    for (const c of CONDS) if (runPhase4ScenarioBaseline({ scenario, baseline: c }).success) e.pass[c] += 1;
  }
  return byType;
}

function main() {
  const { values } = parseArgs({ options: { json: { type: "string" }, macros: { type: "string" } } });
  const byType = evaluate();
  const families = [...byType.keys()];
  const grand = [...byType.values()].reduce((s, e) => s + e.total, 0);
  const tot = Object.fromEntries(CONDS.map((c) => [c, families.reduce((s, f) => s + byType.get(f).pass[c], 0)]));
  const sib = byType.get(SIBLING_FAMILY);

  const failures = [];
  if (tot[TREATMENT] !== grand) failures.push(`C5 did not mediate all ${grand} (${tot[TREATMENT]})`);
  if (tot[COMBINED_CAUSAL] !== tot[TREATMENT]) failures.push(`combined-causal did not tie C5 (${tot[COMBINED_CAUSAL]} vs ${tot[TREATMENT]})`);
  if (!(tot[COMBINED_EXISTS] < grand)) failures.push(`combined-conventional-exists unexpectedly reached ${grand} (${tot[COMBINED_EXISTS]})`);
  if (!sib) failures.push(`missing sibling family ${SIBLING_FAMILY}`);
  else if (sib.pass[COMBINED_EXISTS] !== 0) failures.push(`combined-exists unexpectedly cleared the sibling family (${sib.pass[COMBINED_EXISTS]}/${sib.total})`);

  const status = failures.length === 0 ? "PASS" : "FAIL";
  const result = {
    check: "combined-baseline-residual",
    description: "Strong combined conventional baseline vs MBM on the 180-case per-record suite (deterministic, no API).",
    status,
    failures,
    total_cases: grand,
    treatment: TREATMENT,
    treatment_mediated: tot[TREATMENT],
    combined_causal_mediated: tot[COMBINED_CAUSAL],
    combined_conventional_exists_mediated: tot[COMBINED_EXISTS],
    sibling_family: SIBLING_FAMILY,
    combined_exists_sibling_pass: sib ? `${sib.pass[COMBINED_EXISTS]}/${sib.total}` : null,
    per_family: Object.fromEntries(families.map((f) => [f, { total: byType.get(f).total, pass: byType.get(f).pass }])),
    honest_finding:
      "On the per-record suite a maximal CONVENTIONAL combination (all static + ABAC + ReBAC-referential + capability) " +
      `reaches ${tot[COMBINED_EXISTS]}/${grand}, defeated by the graph-only sibling-branch plant because referential ` +
      "integrity is not recomputed write-event causal reachability. The only combined baseline that ties MBM " +
      "(combined-causal) does so by adopting MBM's reachability predicate. MBM's irreducible residual over even " +
      "that combination is on two non-access-control axes evaluated separately: P8 integrity flow (S4) and " +
      "set-level non-compositionality on a true merge (Proposition 1).",
  };

  const macros = [
    "% Auto-generated by scripts/check_combined_baseline.mjs -- combined-baseline residual gap.",
    `\\newcommand{\\combinedTotalCases}{${grand}}`,
    `\\newcommand{\\mbmMediated}{${tot[TREATMENT]}}`,
    `\\newcommand{\\combinedCausalMediated}{${tot[COMBINED_CAUSAL]}}`,
    `\\newcommand{\\combinedExistsMediated}{${tot[COMBINED_EXISTS]}}`,
    `\\newcommand{\\combinedExistsSiblingPass}{${sib ? sib.pass[COMBINED_EXISTS] : 0}}`,
    `\\newcommand{\\combinedExistsSiblingTotal}{${sib ? sib.total : 0}}`,
    "",
  ].join("\n");

  const jsonPath = values.json || join(REPO, "results", "combined-baseline-residual.json");
  const macroPath = values.macros || join(REPO, "results", "latex", "generated_combined_macros.tex");
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  mkdirSync(dirname(macroPath), { recursive: true });
  writeFileSync(macroPath, macros);

  process.stdout.write(`combined-baseline-residual: ${status}\n`);
  for (const c of CONDS) process.stdout.write(`  ${c.padEnd(34)} ${tot[c]}/${grand}\n`);
  process.stdout.write(`  ${COMBINED_EXISTS} on ${SIBLING_FAMILY}: ${result.combined_exists_sibling_pass}\n`);
  if (status !== "PASS") { for (const f of failures) process.stderr.write(`  - ${f}\n`); process.exit(1); }
}

main();
