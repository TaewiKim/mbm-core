# Third-party datasets

This repository does **not** redistribute the datasets below. They carry their own
licences and attribution requirements, which are not this repository's to grant, and the
MIT licence in [`../LICENSE`](../LICENSE) covers only this repository's own code and
generated files.

Fetch them yourself:

```bash
npm run data:fetch
```

That downloads each dataset from its upstream source into the paths listed here and then
rebuilds the derived fixtures. `npm run data:fetch:check` reports what is present without
downloading anything.

**Check each dataset's own licence and terms before you use or redistribute it.** The
notes below record where each one comes from, not a grant of rights.

## Downloaded sources

| Dataset | Upstream | Fetched into |
|---|---|---|
| HotpotQA (`distractor` / `validation`, first 20 rows) — distributed upstream under **CC BY-SA 4.0**, so preserve attribution and share-alike obligations on anything derived from it | [`hotpotqa/hotpot_qa`](https://huggingface.co/datasets/hotpotqa/hotpot_qa) via the Hugging Face datasets server | `data/raw_sources/hotpotqa_distractor_validation_rows20.json` |
| MAGPIE (`train`, first 20 rows) | [`jaypasnagasai/magpie`](https://huggingface.co/datasets/jaypasnagasai/magpie) via the Hugging Face datasets server | `data/raw_sources/magpie_train_rows20.json` |
| LoCoMo (10 conversations) | [`snap-research/locomo`](https://github.com/snap-research/locomo), `data/locomo10.json` — project page: <https://snap-research.github.io/locomo/> | `data/external/locomo10.json` |

## Derived fixtures

These are transformations of the sources above — they embed upstream text — and so
inherit the upstream licence and attribution requirements. They are rebuilt locally by
the same command and are not committed:

| Fixture | Built from |
|---|---|
| `data/raw_derived/protocol_memory_hotpotqa_evidence_context_20.json` | HotpotQA rows |
| `data/raw_derived/protocol_memory_raw_derived_hard10.json` | HotpotQA + MAGPIE rows |
| `data/raw_derived/protocol_memory_raw_derived_hard20.json` | HotpotQA + MAGPIE rows |

## Result logs

The committed result logs record metrics and model output, and reference benchmark cases by
id — they do not carry upstream dataset text. The two exceptions were the per-row E16 logs,
which quoted LoCoMo questions and gold answers verbatim; those are not committed. Their
aggregate, `results/eval/e16-locomo-analysis.json`, holds the numbers the preprint reports and
is committed. Re-deriving that aggregate means fetching LoCoMo and re-running E16 live, as with
any other live experiment.

## What does not depend on this

No result reported in the accompanying preprint requires these downloads. Every number,
table, figure, and security gate is regenerated from the committed result logs by the
no-API replay:

```bash
node reproduce.mjs --values-only
```

The datasets are needed only to re-run the live experiments from scratch, or to re-derive
the open-source benchmark tracks, which are catalogued in
[`../EXPERIMENTS.md`](../EXPERIMENTS.md).

## Datasets referenced but never downloaded

`docs/open-source-datasets.md` also lists candidate dataset families (AgentLeak, SOTOPIA,
GroupMemBench, FEVER) that shaped the case schema. Nothing in this repository downloads or
redistributes them.
