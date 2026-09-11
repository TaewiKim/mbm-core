#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export {
  DEFAULT_DATASET_PATH,
  DEFAULT_OPENAI_MODEL,
  MEMORY_PROTOCOLS,
  MEMORY_SCENARIOS,
} from "./protocol_memory/constants.mjs";
export {
  HeuristicProtocolMemoryClient,
  OpenAIProtocolMemoryClient,
  emptyDecision,
  heuristicDecision,
} from "./protocol_memory/clients.mjs";
export {
  loadProtocolMemoryDataset,
  parseSelection,
  selectCases,
} from "./protocol_memory/dataset.mjs";
export {
  buildEvents,
  estimateWireBytes,
  evaluateCase,
  runProtocolMemoryCase,
  secretLeakCount,
  validateDecision,
} from "./protocol_memory/evaluation.mjs";
export {
  protocolFeatures,
  visibleCaseForProtocol,
} from "./protocol_memory/protocols.mjs";
export {
  cliArgs,
  main,
  printProtocolMemorySummary,
  runProtocolMemoryBenchmark,
  summarizeProtocolMemoryCases,
} from "./protocol_memory/runner.mjs";
export { makeDecisionSchema } from "./protocol_memory/schema.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { main } = await import("./protocol_memory/runner.mjs");
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
