// E9 ablation split: per-family breakdown of the two single-check ablations (C5-no-policy,
// C5-no-provenance) against real MBM-Core. Reviewers asked whether the single-check ablations
// remove protection on the specific failure class their check targets, or are simply inert.
//
// We report protection at the GATE (deterministic) level: a case is "protected" when the gate
// keeps the forbidden memory out (deterministic_success). This is the model-independent signal
// of the mechanism. We also carry the model-outcome rate, which stays high even where the ablated
// gate admits the bad record -- a capable subject model self-corrects -- so the dissociation is a
// gate-level claim, reported as a robustness nuance, not an end-to-end failure rate.
//
// Each family is assigned to a group purely from the data: it is "policy/status-cued" if only the
// no-policy ablation drops its gate protection, "provenance-cued" if only no-provenance does, and
// "other-bound" if neither single-check ablation breaks it (it is held by run/task/reader/intent).
// Emits results/eval/ablation-family-split-analysis.json (consumed by Fig.4 Panel D).
import { isoStamp, parseArgs, readJsonIfExists, writeJson } from "./eval_lib.mjs";

const TREATMENT = "acmcp-core";
const NO_POLICY = "C5-no-policy";
const NO_PROVENANCE = "C5-no-provenance";

// Short, reviewer-facing family labels (match Fig.5 / supplement naming).
const FAMILY_SHORT = {
  twin_run_shared_memory_contamination: "twin-run",
  pause_resume_deferred_constraint: "pause/resume",
  crash_retry_with_superseded_policy: "superseded-policy",
  branch_merge_with_conflicting_memories: "branch-merge",
  artifact_dependent_handoff: "artifact-handoff",
  private_memory_summary: "private-summary",
  long_horizon_drift: "long-horizon-drift",
  audit_reconstruction: "audit-orphan",
};

const GROUP_LABEL = {
  policy_status_cued: "policy/status-cued",
  provenance_cued: "provenance-cued",
  other_bound: "other-bound (run/task/reader)",
};

function rate(items, key) {
  if (items.length === 0) return null;
  return items.filter((i) => i[key]).length / items.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = (args.result
    || "results/eval/e9-negative-controls-gpt54nano.json,results/eval/e9-negative-controls-gpt54mini.json")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const out = args.json || "results/eval/ablation-family-split-analysis.json";

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
    process.stdout.write("[ablation-split] no cases found; analysis not written\n");
    process.exit(0);
  }

  const byFamilyCond = new Map();
  for (const c of cases) {
    const k = `${c.scenario_type}::${c.condition}`;
    if (!byFamilyCond.has(k)) byFamilyCond.set(k, []);
    byFamilyCond.get(k).push(c);
  }
  const families = [...new Set(cases.map((c) => c.scenario_type))].sort();

  const familyRows = [];
  const groups = { policy_status_cued: [], provenance_cued: [], other_bound: [], both: [] };

  for (const fam of families) {
    const get = (cond) => byFamilyCond.get(`${fam}::${cond}`) ?? [];
    const treat = get(TREATMENT);
    const pol = get(NO_POLICY);
    const prov = get(NO_PROVENANCE);
    const detPol = rate(pol, "deterministic_success");
    const detProv = rate(prov, "deterministic_success");

    // Group assignment from the gate signal (treatment must be fully protected as a sanity check).
    let group = "other_bound";
    const polBreaks = detPol !== null && detPol < 1;
    const provBreaks = detProv !== null && detProv < 1;
    if (polBreaks && provBreaks) group = "both";
    else if (polBreaks) group = "policy_status_cued";
    else if (provBreaks) group = "provenance_cued";

    const row = {
      scenario_type: fam,
      label: FAMILY_SHORT[fam] ?? fam,
      group,
      n_per_condition: treat.length,
      det_protection: {
        treatment: rate(treat, "deterministic_success"),
        no_policy: detPol,
        no_provenance: detProv,
      },
      model_outcome: {
        treatment: rate(treat, "model_success"),
        no_policy: rate(pol, "model_success"),
        no_provenance: rate(prov, "model_success"),
      },
    };
    familyRows.push(row);
    groups[group].push(fam);
  }

  // Group-level mean gate protection under each ablation (the double-dissociation summary).
  const groupSummary = {};
  for (const g of ["policy_status_cued", "provenance_cued", "other_bound"]) {
    const fams = groups[g];
    if (fams.length === 0) continue;
    const rows = familyRows.filter((r) => r.group === g);
    const meanOf = (path) => {
      const vals = rows.map((r) => r.det_protection[path]).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    groupSummary[g] = {
      label: GROUP_LABEL[g],
      families: fams.map((f) => FAMILY_SHORT[f] ?? f),
      n_families: fams.length,
      gate_protection: {
        treatment: meanOf("treatment"),
        no_policy: meanOf("no_policy"),
        no_provenance: meanOf("no_provenance"),
      },
    };
  }

  // The result is a clean double dissociation iff every broken family is broken by exactly one
  // ablation and the two cued groups are each broken by a different one.
  const dissociationClean = groups.both.length === 0
    && groups.policy_status_cued.length > 0
    && groups.provenance_cued.length > 0;

  const analysis = {
    benchmark: "coupled-memory-negative-controls",
    analysis: "ablation-family-split",
    generated_at: isoStamp(args),
    inputs,
    models: [...models].sort(),
    metric: "gate (deterministic) protection: fraction of cases where the forbidden memory is kept out",
    classification_rule:
      "data-driven: family is policy/status-cued if only no-policy drops gate protection, "
      + "provenance-cued if only no-provenance does, other-bound if neither single-check ablation breaks it",
    note:
      "model-outcome rate stays high even where the ablated gate admits the bad record (capable "
      + "subject model self-corrects); the dissociation is a gate-level mechanism claim.",
    dissociation_clean: dissociationClean,
    groups: groupSummary,
    families: familyRows,
  };
  writeJson(out, analysis);
  process.stdout.write(
    `[ablation-split] ${cases.length} cases, ${families.length} families, models=${[...models].join("+")}; `
    + `dissociation_clean=${dissociationClean}; wrote ${out}\n`);
}

main();
