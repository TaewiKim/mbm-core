// The headline SECURITY result as a test (review M4/M5): the full nine-family suite, run end-to-end
// through the ENFORCED secure profile (attestation + lease caller-auth + authoritative lifecycle, no
// bypass), admits no invalid record in any family and every decision is reconstructable. This is the
// run the earlier revision did NOT do (its headline had attestation/caller-auth off and long-horizon
// failed 20/20 under the secure profile).
import test from "node:test";
import assert from "node:assert/strict";
import { runSecureCoverage, PHASE4_MAIN_SCENARIOS } from "../benchmarks/coupled_memory/secure_coverage.mjs";

test("secure profile mediates all nine families on the 180-case main suite", () => {
  const r = runSecureCoverage({ scenarios: PHASE4_MAIN_SCENARIOS });
  assert.equal(r.cases, 180);
  assert.equal(r.total_invalid_admissions, 0, "no invalid record may be admitted under the secure profile");
  assert.ok(r.full_reconstructable, "every secure decision must be reconstructable on replay");
  assert.ok(r.full_selection, "every expected record selected, no forbidden record admitted");
  assert.equal(r.passed, 180);
  // The reviewer's M5 regression specifically: long-horizon drift must pass under the secure profile.
  const lh = r.families.find((f) => f.family === "long_horizon_drift");
  assert.equal(lh.passed, lh.n);
  assert.equal(lh.n, 20);
});
