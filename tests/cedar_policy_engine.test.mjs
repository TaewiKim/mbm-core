// Locks in the deployed-engine cross-check (review M1 empirical reinforcement): the production Cedar
// engine, running an ordinary ABAC+ReBAC policy that imports no MBM-Core code, must reproduce the
// gate's admitted set on every scenario -- and the two ablations must localize the necessary
// predicates. Guards against silent regressions in the gate or the policy mapping.
import test from "node:test";
import assert from "node:assert/strict";

// (artifact robustness) Cedar runs on the @cedar-policy/cedar-wasm npm package. When the artifact is run
// Node-only (no `npm install`), skip these gracefully -- exactly like the LangGraph/AutoGen adapter tests --
// instead of hard-failing at module load. The Cedar cross-check is still committed
// (results/eval/cedar-policy-comparator.json, validated by `npm run eval:check`) and regenerable with
// `npm run policy:cedar` after `npm install`.
let runCedarComparison = null;
let skip = false;
try {
  ({ runCedarComparison } = await import("../scripts/compare_cedar_policy_engine.mjs"));
} catch (e) {
  skip = `@cedar-policy/cedar-wasm not installed (run \`npm install\`): ${String(e.message).split("\n")[0]}`;
}

test("deployed Cedar engine reproduces the gate's admitted set on all scenarios (schema-validated)", { skip }, () => {
  const out = runCedarComparison({ validate: true });
  assert.ok(out.total >= 27, `expected >=27 scenarios, got ${out.total}`);
  assert.equal(out.equivalent_to_gate, out.total, "Cedar must match the C5 gate admitted set on every scenario");
  assert.equal(out.agree_with_js_comparator, out.total, "Cedar must agree with the independent JS ABAC+ReBAC comparator");
  assert.equal(out.all_equivalent, true);
  assert.equal(out.schema_validated, true);
  assert.equal(out.engine, "Cedar");
});

test("the ReBAC causal-ancestry clause is load-bearing on the sibling-branch family", { skip }, () => {
  const out = runCedarComparison({ validate: true });
  assert.ok(
    out.ancestry_load_bearing_families.includes("graph_only_sibling_branch_provenance"),
    "dropping ancestry must change the admitted set on the graph-only sibling-branch family",
  );
});

test("a naive same-run-and-active default false-admits records the gate excludes", { skip }, () => {
  const out = runCedarComparison({ validate: true });
  assert.ok(out.naive_default_false_admits > 0, "naive default must over-admit somewhere");
  assert.ok(out.naive_default_broken_families.length > 0, "naive default must break at least one family");
});
