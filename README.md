# MBM-Core

Reference implementation, adversarial benchmarks, and a no-API reproduction pipeline for
**message-bound, set-level authorization** of shared memory in LLM agent workflows.

Multi-agent LLM workflows coordinate through a shared persistent store they do not isolate — most
concretely, the filesystem. Such stores authorize records *independently*, by scope, provenance, or
causal reachability: they answer whether a record is *relevant*, not whether it is authorized for the
request being served now. Per-record authorization is **not compositional** under a legitimate
multi-parent merge: two conflicting records can each be a genuine ancestor of the active message and
satisfy every record-local predicate, yet their union is not an authorized memory view. Causal
reachability establishes dependency, not adoption.

MBM-Core enforces authorization over the served **set**:

1. it authenticates the actual memory-**write event** and its complete input frontier, rather than a
   writer-supplied source label;
2. it constructs a coherent authoritative view for the active message — concurrent conflicting
   versions require explicit record-level adoption or a resolution certificate bound to the exact
   conflict set, and unresolved versions are never jointly served;
3. it binds that view to a subsequent action through a one-shot, commit-revalidated transaction.

MBM-Core introduces no new policy language and claims no OS-level confinement. Its contribution is a
memory-specific security property and enforcement abstraction; OS-wide non-bypassability remains a
deployment requirement.

## Repository layout

| Path | What it holds |
|------|---------------|
| `benchmarks/` | The kernel, control plane, adversarial scenario suites, and the AutoGen / LangGraph / filesystem-Git integrations |
| `benchmarks/policy_comparator/` | The independently implemented Cedar policy and the conventional-engine comparator |
| `scripts/` | Analysis, exploit PoCs, macro/table export, and the evidence-check gate |
| `tests/` | Deterministic conformance and security regression tests (`node --test`) |
| `data/` | This project's own benchmark datasets: SE-native workflows, the blinded adversarial holdout, long-run episodes, and synthetic fixtures |
| `results/` | Committed result logs for every experiment — the no-API replay reads these |
| `results/latex/` | Generated LaTeX macros and table bodies (regenerated, never hand-edited) |
| `figures/` | Figures as SVG + PDF + PNG, hashed into `results/eval/figure_manifest.json`, with the hand-authored SVG sources under `figures/src/` |
| `tools/` | Figure build pipeline |
| `docs/` | Protocol spec, dataset notes, red-team validation notes, and the artifact environment/expected-results docs |

## Quick start

Requires Node.js 20+.

```bash
npm ci
npm test
```

### Reproduce every number without an API key

All result logs are committed, so every table, figure, macro, and gate is regenerated
deterministically (seeded `mulberry32` paired bootstrap) from those logs. No model API is called.

```bash
node reproduce.mjs --values-only
```

That recomputes the paired-bootstrap analyses, re-exports the LaTeX tables and macros, and runs the
evidence gate — Node only, no Python, no TeX. For the full replay including figure regeneration and
hash verification (adds a Python/matplotlib dependency, see `requirements.txt`):

```bash
node reproduce.mjs
```

To only re-verify what is already committed (SHA-256 figure/table hashes and the G1–G10 evidence
gates):

```bash
node reproduce.mjs --check-only
```

### Third-party datasets

HotpotQA, MAGPIE, and LoCoMo are **not redistributed here** — they carry their own licences
(HotpotQA, for one, is CC BY-SA 4.0), which are not this repository's to grant under MIT. Fetch
them yourself, which also rebuilds the fixtures derived from them:

```bash
npm run data:fetch
```

See [`data/THIRD_PARTY.md`](data/THIRD_PARTY.md) for each source and its obligations, and
`npm run data:fetch:check` to see what is present. Nothing above needs this: the no-API replay,
the test suite, and every number in the preprint come from the committed result logs. The
downloads are required only to re-derive the open-source benchmark tracks or to re-run the live
experiments.

### Security gates

```bash
npm run secure:verify
```

This runs the enforced-boundary suite: write attestation, the exploit PoCs (including the Agent
Security Bench and MINJA memory-poisoning transfers), the concurrent-schedule evaluation, and the
audit-replay self-test.

### Live experiments

The live runs call the OpenAI API and need `OPENAI_API_KEY`. Every experiment, its exact command, and
the result file it writes are catalogued in [`EXPERIMENTS.md`](EXPERIMENTS.md). The committed outputs
of those runs are what the no-API replay above reads, so **re-running them is optional**.

## Scope and honesty

- The evaluation uses synthetic but seeded, hash-frozen attack suites. It establishes **mediation
  coverage and auditability**, and measures the structural *precondition*'s prevalence in real
  frameworks; it does not claim ecological prevalence of end-to-end exploits.
- Selection accuracy ties the strongest conventional defense. The gains are mediation coverage and
  auditability, not selection.
- Gate 2.0 cost and scalability numbers are environment-dependent. The committed measurements are
  replayed rather than re-measured, so the replay does not depend on your host.
- The manuscript sources are not part of this repository; see the accompanying preprint. That is why
  `reproduce.mjs --paper` is unavailable here, and why `eval:check` reports `paper_figure_coverage`
  as *pending* rather than *pass*.
- **Figures.** The data figures are drawn by `tools/build_figures.py` and re-rendered by
  `npm run eval:figures`, which rewrites `results/eval/figure_manifest.json`; `eval:check` verifies
  every figure against that ledger. The schematic figures are integrated as static assets and need a
  native SVG rasterizer to re-render, so they ship as committed SVG/PDF/PNG. No numeric result
  depends on the figure pipeline: `eval:values` is Node-only and recomputes everything from the
  committed result logs.

## License

MIT — see [`LICENSE`](LICENSE). It covers this repository's own code, data, and generated
files. It does **not** cover the third-party datasets that `npm run data:fetch` downloads:
those keep their upstream licences and attribution requirements, listed in
[`data/THIRD_PARTY.md`](data/THIRD_PARTY.md).
