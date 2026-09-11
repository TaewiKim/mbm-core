# E16 — External-benchmark drop-in (native metric)

Pre-registered in `docs/prereg_E13_E16.md` (H16). Goal: rebut the treatment-design threat by
showing MBM-Core helps on **someone else's tasks**, scored by **their own success metric** — not FFCR,
not our data.

## Design

`mbm_gate.mjs` is a standalone, DB-free copy of the production gate
(`benchmarks/coupled_memory/runtime.mjs::evaluateMemoryGate`) — identical 7 conjunctive checks and
reason codes. `wrapMemoryRead(rawRead, opts)` drops the gate around any external benchmark's
memory/context read: candidate records (stamped with run/task/status/provenance/reader/policy metadata)
go in, only admitted records come out, with an audit trail.

Conditions are paired per task instance: **native (gate off)** vs **native + MBM (gate on)**. We report
the benchmark's **native** success metric, plus the reduction in mismatch-attributable failures.

## Status in this build environment: BLOCKED (no internet)

The full run requires fetching external datasets/harnesses (τ-bench, LoCoMo) from GitHub/HF, which are
**not reachable here** (only `api.openai.com` is allow-listed). Per the prereg, E16 is therefore
delivered as a complete adapter + a connectivity/no-op pilot; the full live run executes where the
datasets are available. **No external numbers are fabricated.**

`external_pilot.mjs` runs offline and proves the wrapper (a) hooks a stateful task's memory read and
(b) is **not a no-op**: on a synthetic multi-session store where a wrong-run record ranks first, the
unwrapped read fails the native task while the wrapped read admits only the valid record and succeeds.

```
node benchmarks/external/external_pilot.mjs
# native_off success: false ; native+MBM success: true ; not_a_no_op: true
```

## Running the full E16 (where datasets are reachable)

1. **τ-bench** (primary; policy/state validity == our mechanism):
   - Install τ-bench; expose its per-turn context/DB read as `rawRead(activeMessage)` returning candidate
     records stamped with `{run_id, task_id, status, source_message_id, allowed_readers, policy_context}`
     derived from the task's user/session/policy state.
   - Wrap with `wrapMemoryRead`; run both conditions; score with τ-bench `pass^k`.
2. **LoCoMo** (secondary; multi-session memory QA):
   - Map each session to a `run_id`; stamp memories with their source session; wrap the retrieval step.
   - Score with LoCoMo QA accuracy.
3. Write paired results to `results/eval/e16-<bench>.json` and add an analyzer mirroring
   `analyze_sota_best_baseline.mjs` (paired bootstrap on the native metric).

## No-Go (honest)

If an external benchmark has no real cross-context shared state, the gate is a no-op there — report the
null and scope the claim to "cross-context shared-memory workflows." That is a valid external-validity
result, not a failure.
