import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

export const MEMORY_PROTOCOLS = [
  "freeform-chat",
  "typed-envelope",
  "evidence-capsule",
  "proof-capability",
  "commitment-receipt",
  "scoped-memory",
  "acmcp-full",
  "acmcp-no-evidence",
  "acmcp-no-proof",
  "acmcp-no-commitment",
  "acmcp-no-scope",
  "acmcp-no-policy-trace",
  "acmcp-no-context-manifest",
  "mpac-coordination",
  "mesh-memory",
  "q-kvcomm-compressed",
];

export const MEMORY_SCENARIOS = [
  "capability_market",
  "capability_deception",
  "evidence_synthesis",
  "evidence_conflict",
  "delegation_drift",
  "scoped_memory_privacy",
  "shared_memory_consistency",
  "cross_session_rehydration",
  "context_manifest_stress",
];

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATASET_PATH = resolve(
  MODULE_DIR,
  "../../data/open_source_fixtures/protocol_memory_seed.json",
);
