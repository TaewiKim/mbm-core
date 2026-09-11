# Adversarial validation log (red-team)

This document records the multi-round adversarial validation of the message-bound memory
kernel (`benchmarks/coupled_memory/runtime.mjs`, `benchmarks/coupled_memory/control_plane.mjs`).
It backs the supplement's statement that the audit "iterated until a full round found no new
bypass." Every confirmed finding below is reproduced as an executable regression in
`scripts/repro_v20.mjs` (chained into `npm run regress:v18 -> npm run secure:verify`), so the
claims here are checkable, not narrative.

## Methodology

- **Loop-until-clean.** Each round runs several independent *finder* lenses, each targeting a
  distinct mechanism; each writes a proof-of-concept and runs it end-to-end through the public
  `createSecureMemorySystem` facade (no privileged internals). A separate *skeptic* re-runs each
  claimed bypass and rules it a real, in-scope soundness break or not. The round is **clean** only
  when no lens yields a confirmed, in-scope break. Rounds continue until a clean round on the
  *current* code; any TCB change reopens the loop.
- **Trust by verification, not authorship.** Finder/skeptic agents may write PoCs only to scratch
  paths; they never edit the trusted computing base. Every fix to the kernel was reviewed line by
  line before landing.
- **In-scope finding** = a soundness break reachable *without forging trusted state* (no
  control-plane key, no kernel-DB write, no MAC-head/ledger forgery): admitting an invalid or
  post-hoc record to the model; exposing a tampered, widened, or incomplete view; dispatching an
  unauthorized external effect; or making the secure audit-replay miss a real serve. Availability
  (a legitimate read that fails closed) is out of scope.
- **Documented residual (explicitly not a bypass).** A sequence cut is not a happens-before oracle
  against an adversary that creates *its own* high-sequence reader after writing a record sourced
  at a shared ancestor — that is shared-memory semantics, bounded by integrity flow (a lower-trust
  post-hoc write is denied `integrity_below_context`). The paper claims only the conjunction.

## v19 series (prior work, summarized)

The set-level coherent-view / resolution-certificate subsystem was the recurring bypass hot spot.
The v19 loop ran ten rounds and fixed nineteen confirmed bypasses; the dominant capability-meet
fail-open class was closed structurally by rewriting the cap predicate as a **fail-safe inverse**
(a keyed restriction caps the meet unless it was *authoritatively* removed), and the
trusted/untrusted DB split (round 9) was closed by fully qualifying every kernel-state access as
`kernel.<table>`. Round 10 converged clean. Regressions: `scripts/repro_v19.mjs` (#1..#21).

## v20 series (write-event causal unit)

The v20 review showed the gate authenticated a record's *claimed source-message* ancestry, not the
actual *write event* and its input frontier. Fixing this moved the causal unit from message to
write event and triggered a fresh convergence loop. The finding count decreased each round
(5 -> 3 -> 2 -> 0), the signature of convergence.

### Round 11 (5 confirmed)

| # | Mechanism (pre-fix) | Fix | Regression |
|---|---|---|---|
| late-write | gate checked source-message ancestry, not the write event; a writer re-claiming an old ancestor laundered a post-hoc record into a victim's past | write events get a monotonic `write_seq`; gate admits only `write_seq <= ` the reader's cut (later refined to the active message's signed creation sequence, round 12) | CE20-00 |
| hidden input | attached context inputs lowered integrity but were not bound as dependencies | record binds its full `input_frontier`; gate requires each input reachable in the reader's closure | CE20-01 |
| message adoption | adoption keyed on the source message, so a post-adopt record inherited authority | record-scoped adoption binds `record_id`, `record_digest`, and exact `write_seq`; bare source-message adoption adopts nothing | CE20-02 |
| context replay | execution contexts had no anti-rollback head; a pre-taint snapshot restore removed an integrity taint across restart | per-context monotonic version head in `kernel.context_anchor`; a rolled-back context loads `aborted` | CE20-03 |
| input-frontier delegation waiver | a record-level delegation cert waived the *entire* input-frontier check | each input must be reachable regardless of delegation | CE20-09 |
| adoption fail-open | a non-numeric adopt-edge sequence mapped to `Infinity` (adopt everything); a non-numeric envelope sequence was signable and poisoned `Number(seq)=NaN` | fail-closed `-Infinity`; `requireEnvelope` rejects a non-integer/negative sequence at the source | CE20-10 |

### Round 12 (3 confirmed)

| # | Mechanism (pre-fix) | Fix | Regression |
|---|---|---|---|
| clock rollback | the write-event clock (`runs.next_sequence`) lived in the untrusted main DB; a store rollback let a late write allocate a low `write_seq` and launder a post-hoc record into a fixed trusted victim | the clock joins the anti-rollback kernel DB (`kernel.run_clock`, in `KERNEL_TABLES`); allocation uses `MAX(advisory main, trusted kernel)` and advances both | CE20-06 |
| input-frontier non-transitive | `attachContextInput` folded only the additional lease's primary message, dropping a chained context's hidden low-integrity input | fold the additional context's full frontier + accumulated integrity transitively | CE20-07 |
| off-branch cert winner | `_computeView` applied the cert winner's ceiling with no reader-closure check, widening the meet for an unreachable permissive winner | winner contributes `[]` unless reachable (later generalized, round 13) | CE20-08 |

### Round 13 (2 confirmed)

| # | Mechanism (pre-fix) | Fix | Regression |
|---|---|---|---|
| attach-then-mutate | the transitive fold snapshots at attach time; mutating the child after attach left the parent stale | freeze-on-attach: a context consumed as an input refuses further inputs (`context_frozen_after_attach`) | CE20-12 |
| post-hoc cert winner | the off-branch winner check missed the write-event cut; a post-hoc winner sourced at a shared ancestor still widened the meet | **generalized fix:** the cert winner's ceiling widens the meet only if the winner is *actually admitted to this reader* (its final per-record + coherent-view verdict is `allow`) — unifying off-branch, post-hoc, retired, and Biba-unreadable into one admissibility test | CE20-11 |

### Round 14 — clean

Five lenses (verdict-gated cert ceiling, freeze-on-attach + transitive frontier, run-clock
anti-rollback, and two broad-composition sweeps) yielded no confirmed in-scope break. The clock
invariant and freeze defenses were probed and found airtight; every broad composition failed
closed. The loop converged.

## Two general lessons (each found twice)

1. **Anti-rollback for every monotonic value.** A new dependency on a "monotonic" counter must ask
   *where that value lives*. The write-event clock had to join the membership / lifecycle /
   resolution / context anchors in the trusted kernel DB (CE20-03's lesson, re-applied at CE20-06).
2. **The fail-safe inverse for every authority-granting attribute.** Enumerating the reasons an
   attribute *still caps / is disqualified* leaks by omission, round after round. Gating instead on
   the record being *admissible to the consumer* is the inverse and is complete. This closed both
   the keyed-restriction meet (v19) and the cert-winner ceiling (v20, CE20-08/11).

## Reproducing this validation

```sh
node scripts/repro_v20.mjs        # CE20-00..12 — every red-team finding, all blocked
node scripts/repro_v19.mjs        # v19 #1..#21
npm run hard:separation           # content-blind family separation (C4 7/7 exploited, C5 0/7)
npm run secure:verify             # full battery (gates, schedules, regressions, replay self-test)
```

The threat-coverage tables in the accompanying preprint map each attack
class to its mechanism and the regression that demonstrates it.
