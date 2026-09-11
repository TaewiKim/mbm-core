# HotpotQA Raw-Derived Benchmark

This track adds one open-source raw-derived benchmark to the protocol-memory
study. It converts HotpotQA rows into protocol-oracle cases for evidence and
context-management stress tests.

## Source

The full-validation paths below are produced locally by the commands in this
document; they are not committed to this repository.

| Field | Value |
|---|---|
| Dataset | HotpotQA |
| Local raw rows | `data/raw_sources/hotpot_dev_distractor_v1.json` |
| Derived benchmark | `data/raw_derived/protocol_memory_hotpotqa_validation_evidence_context_full.json` |
| Source URL | https://hotpotqa.github.io/ |
| License note | HotpotQA is distributed as CC BY-SA 4.0 by the upstream project; preserve attribution and license obligations when redistributing derived rows. |

## Conversion

Command:

```bash
npm run raw:build:hotpotqa:validation
```

The converter maps each HotpotQA row into two protocol cases:

| Scenario | Cases | Protocol property tested |
|---|---:|---|
| `evidence_conflict` | 7,405 | Whether claims are backed by valid supporting facts and stale decoys are rejected |
| `context_manifest_stress` | 7,405 | Whether large evidence bundles are referenced through compact context manifests without dropping critical facts |

The output is compact JSON to keep the repository file under the 1000-line
limit.

## Benchmark

Command:

```bash
npm run raw:bench:hotpotqa:validation:dryrun
npm run raw:check:hotpotqa:validation
```

Current dry-run setup:

| Field | Value |
|---|---|
| Protocols | `typed-envelope`, `evidence-capsule`, `acmcp-full`, `acmcp-no-evidence`, `acmcp-no-context-manifest`, `q-kvcomm-compressed` |
| Scenarios | `evidence_conflict`, `context_manifest_stress` |
| Runs | 1 |
| Benchmark cases | 88,860 |
| Result | `results/hotpotqa-validation-raw-derived-dryrun-summary-seed2061.json` |
| Check | `results/hotpotqa-validation-raw-derived-check.md` |

Current checked result:

| Protocol / scenario | Success rate |
|---|---:|
| `acmcp-full` / `evidence_conflict` | 1.0 |
| `acmcp-full` / `context_manifest_stress` | 1.0 |
| `typed-envelope` / `evidence_conflict` | 0.0 |
| `acmcp-no-context-manifest` / `context_manifest_stress` | 0.0 |

## Claim Boundary

Allowed:

> On a HotpotQA-derived evidence/context track, the full protocol succeeds on
> provenance and context-manifest cases where targeted ablations fail.

Not allowed:

> This is a HotpotQA question-answering leaderboard result.

The benchmark uses HotpotQA rows as source material for protocol-oracle
stress cases. It evaluates communication-memory protocol behavior, not general
QA accuracy.

## Live LLM Subset

The current headline live subset uses `gpt-5.4-mini` and `gpt-5.4-nano` with
parallel calls, constrained candidate answers, and one repair attempt:

```bash
npm run raw:bench:hotpotqa:validation:live:gpt54mini:c20
npm run raw:bench:hotpotqa:validation:live:gpt54nano:c20
npm run raw:combine:hotpotqa:validation:live:gpt54:c20
npm run raw:analyze:hotpotqa:validation:live:gpt54:combined
```

| Field | Value |
|---|---|
| Cases | 20 per scenario, 2 scenarios, 6 protocols, 2 models = 480 live calls |
| API errors | 0 |
| Parse/validation errors | 0 |
| Evidence contrast | `acmcp-full` 0.825 vs `acmcp-no-evidence` 0.000 |
| Context contrast | `acmcp-full` reduces wire bytes by about 48K vs `acmcp-no-context-manifest` |

Interpretation:

- The live subset strongly supports the mechanism claim that evidence support
  and context manifests address complementary failure modes.
- The repair run substantially improves strict success relative to the first
  `gpt-5-nano` smoke run.
- The live subset should still be reported separately from the deterministic
  full-validation benchmark.

## Broad Raw-Derived Live Extension

The broader raw-derived live track combines HotpotQA-derived evidence/context
cases with MAGPIE-derived capability, delegation, and scoped-memory cases:

```bash
npm run raw:build:hard20
npm run raw:bench:hard20:live:gpt54mini:c10
npm run raw:bench:hard20:live:gpt54nano:c10
npm run raw:combine:hard20:live:gpt54:c10
npm run raw:analyze:hard20:live:gpt54:combined
```

| Field | Value |
|---|---|
| Cases | 5 scenarios, 10 cases per scenario, 12 protocols, 2 models = 1,200 live calls |
| API errors | 0 |
| Parse/validation errors | 0 |
| Evidence contrast | `evidence-capsule` 0.800 vs `typed-envelope` 0.000 |
| Proof contrast | `proof-capability` 0.500 vs `typed-envelope` 0.000 |
| Commitment contrast | `commitment-receipt` 0.700 vs `proof-capability` 0.000 |
| Scoped-memory contrast | leak events 0 for `scoped-memory` vs 1 for `commitment-receipt` |
| Context contrast | `acmcp-full` reduces wire bytes by about 48K vs `evidence-capsule` |
| Full-protocol ablations | evidence, proof, commitment, scope, policy-trace, and context-manifest removals each expose the expected failure mode |

This broad extension is the current live mechanism table for ACM-CP. It is
larger than the HotpotQA-only live subset and covers reliability, safety, and
memory/context management in one raw-derived protocol benchmark.
