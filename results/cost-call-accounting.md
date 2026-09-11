# Cost And Call Accounting

ACM-CP live experiment cost/call accounting

Pricing note: USD not computed because no pricing file was supplied.

| Track | Models | Calls | API errors | Parse errors | Invalid | Repairs | Prompt tokens est. | Wire bytes | Mean latency ms | USD est. |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| coupled_live_main40_r3 | gpt-5-mini, gpt-5-nano | 480 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | N/A |
| dropin_live_main40_r3 | gpt-5.4-mini, gpt-5.4-nano | 480 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | N/A |
| raw_broad_live_hard20_c10 | gpt-5.4-mini, gpt-5.4-nano | 1200 | 0 | 0 | 0 | 640 | 2554330 | 10215524 | 13945.1 | N/A |
| hotpotqa_live_c20 | gpt-5.4-mini, gpt-5.4-nano | 480 | 0 | 0 | 0 | 284 | 2725488 | 10901191 | 29628.2 | N/A |

## Totals

- calls: 2640
- successful_api_calls: 2640
- api_errors: 0
- parse_errors: 0
- invalid_decisions: 0
- repairs_used: 924
- prompt_tokens_estimate_total: 5279818
- wire_bytes_total: 21116715
- latency_ms_total: 30955657.668999996
- cost_usd_estimate: N/A

## Commands

- coupled_live_main40_r3: `npm run coupled:combine:phase6:live:main40-r3`
- dropin_live_main40_r3: `npm run dropin:combine:live:main40-r3`
- raw_broad_live_hard20_c10: `npm run raw:combine:hard20:live:gpt54:c10`
- hotpotqa_live_c20: `npm run raw:combine:hotpotqa:validation:live:gpt54:c20`

