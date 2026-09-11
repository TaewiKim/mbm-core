# Environment

## Required

- Node.js >= 22 (uses built-in `node:sqlite` and `node:test`). Verified on Node 25.8.
- npm (for `npm ci` / scripts).
- Dependencies (installed by `npm ci`): `@resvg/resvg-js` (SVG→PNG raster),
  `@langchain/langgraph` (native-integration benchmark).

## Optional

- An SVG→PDF converter for PDF figure outputs: `rsvg-convert`, `inkscape`, or `cairosvg`.
  Without one, the pipeline still emits SVG + PNG and records their hashes; PDF outputs are
  skipped with a printed note.
- A TeX distribution with `IEEEtran.cls` to build `paper/main.tex`.
- Python `autogen-agentchat` only for the optional AutoGen native-adapter test. If it is absent,
  `npm test` reports one expected skip and the default no-API artifact replay remains valid.
- `OPENAI_API_KEY` for live reproduction (OpenAI Responses API, models `gpt-5.4-mini` /
  `gpt-5.4-nano`).

## Determinism

- Scenario generation and bootstrap use explicit integer seeds.
- The bootstrap RNG is `mulberry32` (`scripts/eval_lib.mjs`), so analysis outputs are
  bit-reproducible across machines for a fixed input + seed.
- The no-API replay (`npm run eval:artifact:check`) is fully deterministic.
