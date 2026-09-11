// Regression: a prototype-member intent/condition must NOT resolve to an inherited Object.prototype member.
// Before the fix, INTENT_MEMORY_TYPES / CONDITION_FEATURES / CONDITION lookups were plain object literals, so an
// attested message whose intent was "constructor" (or "toString"/"__proto__"/"hasOwnProperty"/...) made
// INTENT_MEMORY_TYPES[intent] return a truthy inherited function. That truthy value slipped past the
// fail-closed `intent_unknown` guard and then threw "allowedTypes.has is not a function", aborting the read with
// an unhandled TypeError (an availability bug) instead of a clean fail-closed deny. Same exposure for
// CONDITION_FEATURES[condition]. The fix makes those lookups null-prototype + own-property-guarded, matching the
// already-hardened TOOL_REGISTRY/resolveTool. These tests lock the clean fail-closed behavior into `npm test`.
import test from "node:test";
import assert from "node:assert/strict";

import { CoupledMemoryRuntime, SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
import { INTENT_MEMORY_TYPES, CONDITION_FEATURES } from "../benchmarks/coupled_memory/constants.mjs";

const PROTOTYPE_MEMBERS = ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty", "isPrototypeOf"];

// ---- the lookup tables themselves are null-prototype (no inherited members leak through) ----
test("INTENT_MEMORY_TYPES / CONDITION_FEATURES expose no inherited prototype members", () => {
  for (const name of PROTOTYPE_MEMBERS) {
    assert.equal(INTENT_MEMORY_TYPES[name], undefined, `INTENT_MEMORY_TYPES[${name}] must be undefined`);
    assert.equal(CONDITION_FEATURES[name], undefined, `CONDITION_FEATURES[${name}] must be undefined`);
  }
  assert.equal(Object.getPrototypeOf(INTENT_MEMORY_TYPES), null);
  assert.equal(Object.getPrototypeOf(CONDITION_FEATURES), null);
  // sanity: the real keys still resolve.
  assert.ok(INTENT_MEMORY_TYPES.produce_final_plan instanceof Set);
  assert.ok(CONDITION_FEATURES.C5.messageBoundMemory);
});

// ---- base gate (evaluateMemoryGate, ~line 604): "constructor" intent must not throw ----
test("base gate: a prototype-member intent reads cleanly instead of throwing", () => {
  const rt = new CoupledMemoryRuntime({});
  rt.ensureRun("run1");
  const msg = rt.sendMessage({ message_id: "m1", run_id: "run1", task_id: "t1", trace_id: "tr",
    sender: "a", receiver: "b", intent: "constructor", state: "active", sequence: 1, policy_context: "P" });
  rt.writeMemory("X", msg, { memory_id: "mem-ok", allowed_readers: ["*"] });
  let admitted;
  // Pre-fix this threw "allowedTypes.has is not a function". The base gate is permissive on an UNKNOWN
  // intent (it has no entry, like "share"), so the record is admitted -- the point is that it does not throw.
  assert.doesNotThrow(() => { admitted = rt.readMemory({}, msg, { condition: "C5" }); });
  assert.equal(admitted.length, 1);
  rt.close();
});

// ---- condition lookup (readMemory, ~line 417): a prototype-member condition fails closed, not silently ----
test("condition lookup: a prototype-member condition hits the unknown-condition guard", () => {
  const rt = new CoupledMemoryRuntime({});
  rt.ensureRun("run1");
  const msg = rt.sendMessage({ message_id: "m1", run_id: "run1", task_id: "t1", trace_id: "tr",
    sender: "a", receiver: "b", intent: "share", state: "active", sequence: 1, policy_context: "P" });
  // Pre-fix CONDITION_FEATURES["constructor"] resolved to the Object constructor (truthy), so the
  // `unknown condition` guard was skipped and the read silently returned [] (wrong-but-quiet). Now it throws.
  assert.throws(() => rt.readMemory({}, msg, { condition: "constructor" }), /unknown condition/);
  rt.close();
});

// ---- secure gate (evaluateSecureGate, ~line 1284): end-to-end fail-closed deny, no throw ----
test("secure gate: a prototype-member intent fail-closes (intent_unknown), admitting nothing", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const seed = cp.registerPrincipal("seed-writer", { queues: ["*"] });
  const sessA = cp.registerPrincipal("agentA", {});
  const sessB = cp.registerPrincipal("agentB", {});
  // A source message carries the memory; the active READ message is its causal child but carries a
  // prototype-member intent. (Writer and reader hold leases on different messages, so neither blocks the
  // other -- mirrors the secure-coverage write-then-read shape.)
  rt.sendMessage({ message_id: "src", run_id: "run1", task_id: "t1", trace_id: "tr", sender: "agentA",
    receiver: "worker", intent: "produce_final_plan", state: "active", sequence: 1, policy_context: "P" }, sessA);
  rt.sendMessage({ message_id: "act", run_id: "run1", task_id: "t1", trace_id: "tr", sender: "agentB",
    receiver: "reader", intent: "constructor", state: "active", sequence: 2, parent_message_id: "src",
    policy_context: "P" }, sessB);
  const wlease = rt.claimSpecific(seed, "src");
  // memory_type "summary" WOULD be allowed if the intent were a real, known intent -- so the only thing
  // keeping this record out is the intent fail-close, not a type/reader/provenance/policy mismatch.
  rt.writeMemory("X", wlease, { memory_id: "mem-ok", memory_type: "summary", allowed_readers: ["*"] });
  const rlease = rt.claimSpecific(cp.registerPrincipal("reader", { queues: ["reader"] }), "act");
  let admitted;
  // Pre-fix this threw "allowedTypes.has is not a function" inside evaluateSecureGate, aborting the read.
  assert.doesNotThrow(() => { admitted = rt.readMemory({}, rlease).map((m) => m.memory_id); });
  assert.deepEqual(admitted, [], "no record may be admitted under a prototype-member intent");
  rt.close();
});
