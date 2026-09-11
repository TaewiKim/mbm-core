#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_BASE_URL = "https://datasets-server.huggingface.co/rows";

function buildUrl({ dataset, config, split, offset, length }) {
  const params = new URLSearchParams({
    dataset,
    config,
    split,
    offset: String(offset),
    length: String(length),
  });
  return `${DEFAULT_BASE_URL}?${params}`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fetchJson(url, retries = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const body = execFileSync("curl.exe", [
        "--ssl-no-revoke",
        "-L",
        "-sS",
        "-H",
        "User-Agent: agent-protocol-benchmark/0.1",
        url,
      ], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      sleep(500 * attempt);
    }
  }
  throw new Error(`failed to fetch ${url}: ${lastError?.message}`);
}

export function downloadRows({
  dataset = "hotpotqa/hotpot_qa",
  config = "distractor",
  split = "validation",
  pageSize = 100,
  limit = 0,
}) {
  let features = null;
  let total = null;
  const rows = [];
  for (let offset = 0; total === null || offset < total; offset += pageSize) {
    const length = total === null
      ? pageSize
      : Math.min(pageSize, total - offset);
    const page = fetchJson(buildUrl({ dataset, config, split, offset, length }));
    features ??= page.features;
    total ??= limit > 0 ? Math.min(page.num_rows_total, limit) : page.num_rows_total;
    rows.push(...page.rows);
    if (rows.length >= total || page.rows.length === 0) {
      break;
    }
  }
  return {
    features,
    rows: rows.slice(0, total),
    num_rows_total: total,
    num_rows_per_page: pageSize,
    partial: limit > 0,
    source: {
      dataset,
      config,
      split,
      url: DEFAULT_BASE_URL,
    },
  };
}

const parsed = parseArgs({
  options: {
    dataset: { type: "string", default: "hotpotqa/hotpot_qa" },
    config: { type: "string", default: "distractor" },
    split: { type: "string", default: "validation" },
    output: { type: "string", default: "data/raw_sources/hotpotqa_distractor_validation_full.json" },
    "page-size": { type: "string", default: "100" },
    limit: { type: "string", default: "0" },
  },
});

if (process.argv[1]?.endsWith("download_hotpotqa_rows.mjs")) {
  const dataset = downloadRows({
    dataset: parsed.values.dataset,
    config: parsed.values.config,
    split: parsed.values.split,
    pageSize: Number.parseInt(parsed.values["page-size"], 10),
    limit: Number.parseInt(parsed.values.limit, 10),
  });
  writeFileSync(parsed.values.output, `${JSON.stringify(dataset)}\n`, "utf8");
  console.log(`Wrote ${parsed.values.output}`);
  console.log(`Rows: ${dataset.rows.length}`);
}
