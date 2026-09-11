#!/usr/bin/env node
// Run the nine-family attack suite end-to-end under the ENFORCED secure profile (review M4/M5).
// Emits results/eval/secure-coverage-main.json and exits non-zero unless mediation coverage is total
// (0 invalid admissions), every case is reconstructable, and selection is perfect across all families.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSecureCoverage, PHASE4_MAIN_SCENARIOS, PHASE4_SCENARIOS, INTEGRITY_FLOW_SCENARIOS } from "../benchmarks/coupled_memory/secure_coverage.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const split = process.argv.includes("--dev") ? "dev" : "main";
const scenarios = split === "dev" ? PHASE4_SCENARIOS : PHASE4_MAIN_SCENARIOS;
// The legacy nine families (context-authorization axis) AND the integrity-flow family (the second,
// content-trust axis) are both run end-to-end through the enforced SecureMemoryRuntime. The integrity
// set is reported separately because it is deliberately beyond ABAC+ReBAC (the Cedar comparator covers
// only the context axis); together they form the full mediation/selection/reconstructability headline.
const report = runSecureCoverage({ scenarios, benchmark: `coupled-memory-secure-coverage-${split}` });
const ifc = runSecureCoverage({ scenarios: INTEGRITY_FLOW_SCENARIOS, benchmark: "coupled-memory-secure-coverage-integrity-flow" });

mkdirSync(join(REPO, "results", "eval"), { recursive: true });
writeFileSync(join(REPO, "results", "eval", `secure-coverage-${split}.json`), JSON.stringify(report, null, 2));
writeFileSync(join(REPO, "results", "eval", "secure-coverage-integrity-flow.json"), JSON.stringify(ifc, null, 2));

for (const [label, rep] of [[split, report], ["integrity-flow", ifc]]) {
  console.log(`[secure-coverage:${label}] cases=${rep.cases} passed=${rep.passed} ` +
    `invalid_admissions=${rep.total_invalid_admissions} unreconstructable=${rep.total_unreconstructable}`);
  for (const f of rep.families) {
    const flag = f.passed === f.n ? "PASS" : "FAIL";
    console.log(`  [${flag}] ${f.family}: ${f.passed}/${f.n} pass, ${f.invalid_admissions} invalid admissions`);
  }
}
const okOf = (r) => r.full_mediation && r.full_reconstructable && r.full_selection;
const ok = okOf(report) && okOf(ifc);
console.log(`secure profile: full_mediation=${report.full_mediation && ifc.full_mediation} ` +
  `full_reconstructable=${report.full_reconstructable && ifc.full_reconstructable} ` +
  `full_selection=${report.full_selection && ifc.full_selection} => ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
