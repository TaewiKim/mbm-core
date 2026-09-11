import { MEMORY_PROTOCOLS } from "./constants.mjs";

export function protocolFeatures(protocol) {
  if (protocol === "mpac-coordination") {
    return {
      typedEnvelope: true,
      evidenceCapsule: false,
      proofCapability: false,
      commitmentReceipt: true,
      scopedMemory: true,
      contextManifest: false,
      causalPolicyTrace: true,
      redactionPolicy: false,
    };
  }
  if (protocol === "mesh-memory") {
    return {
      typedEnvelope: true,
      evidenceCapsule: true,
      proofCapability: false,
      commitmentReceipt: false,
      scopedMemory: true,
      contextManifest: false,
      causalPolicyTrace: true,
      redactionPolicy: true,
    };
  }
  if (protocol === "q-kvcomm-compressed") {
    return {
      typedEnvelope: true,
      evidenceCapsule: false,
      proofCapability: false,
      commitmentReceipt: false,
      scopedMemory: false,
      contextManifest: true,
      causalPolicyTrace: false,
      redactionPolicy: false,
    };
  }
  if (protocol.startsWith("acmcp-")) {
    return {
      typedEnvelope: true,
      evidenceCapsule: protocol !== "acmcp-no-evidence",
      proofCapability: protocol !== "acmcp-no-proof",
      commitmentReceipt: protocol !== "acmcp-no-commitment",
      scopedMemory: protocol !== "acmcp-no-scope",
      contextManifest: protocol !== "acmcp-no-context-manifest",
      causalPolicyTrace: protocol !== "acmcp-no-policy-trace",
      redactionPolicy: protocol !== "acmcp-no-scope" && protocol !== "acmcp-no-policy-trace",
    };
  }
  const order = MEMORY_PROTOCOLS.indexOf(protocol);
  return {
    typedEnvelope: order >= MEMORY_PROTOCOLS.indexOf("typed-envelope"),
    evidenceCapsule: order >= MEMORY_PROTOCOLS.indexOf("evidence-capsule"),
    proofCapability: order >= MEMORY_PROTOCOLS.indexOf("proof-capability"),
    commitmentReceipt: order >= MEMORY_PROTOCOLS.indexOf("commitment-receipt"),
    scopedMemory: order >= MEMORY_PROTOCOLS.indexOf("scoped-memory"),
    contextManifest: protocol === "acmcp-full",
    causalPolicyTrace: protocol === "acmcp-full",
    redactionPolicy: protocol === "scoped-memory" || protocol === "acmcp-full",
  };
}

function removeKeys(value, keys) {
  if (Array.isArray(value)) {
    return value.map((item) => removeKeys(item, keys));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) {
      copy[key] = removeKeys(item, keys);
    }
  }
  return copy;
}

export function visibleCaseForProtocol(caseRecord, protocol) {
  const features = protocolFeatures(protocol);
  const hiddenOracleKeys = new Set([
    "oracle_agent",
    "oracle_answer",
    "oracle_conflict_action",
    "required_memory_ids",
    "forbidden_memory_ids",
    "forbidden_shared_fields",
    "secret_markers",
  ]);
  const visible = removeKeys(caseRecord, hiddenOracleKeys);
  if (Array.isArray(visible.agents) && !features.proofCapability) {
    visible.agents = visible.agents.map((agent) => {
      const copy = { ...agent };
      delete copy.verified_capabilities;
      delete copy.proof_valid;
      delete copy.evaluation_evidence;
      delete copy.revocation_status;
      return copy;
    });
  }
  if (Array.isArray(visible.evidence) && !features.evidenceCapsule) {
    visible.evidence = visible.evidence.map((item) => {
      const copy = { ...item };
      delete copy.supports_claims;
      delete copy.source;
      delete copy.validity;
      return copy;
    });
  }
  if (Array.isArray(visible.memories) && !features.scopedMemory) {
    visible.memories = visible.memories.map((item) => {
      const copy = { ...item };
      delete copy.status;
      delete copy.usefulness;
      return copy;
    });
  }
  return visible;
}
