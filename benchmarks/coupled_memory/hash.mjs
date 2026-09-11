// Content-integrity hashing AND write-time attestation for shared-memory records (review M4/M1).
// Pure, dependency-free (no SQLite) so BOTH the SQLite runtime and the standalone/external gate
// compute and verify identically.
import { createHash, createHmac } from "node:crypto";

// Fields that are NOT part of the integrity-hashed content: the stored hash/receipt themselves and
// mutable timestamps. EVERYTHING ELSE the record carries -- including action-relevant extension
// fields the executor consumes (e.g. retention_days, created_seq) -- is covered, so a later edit to
// any consumed field is detectable (review M4: action fields must be inside the hash).
const NON_CONTENT_FIELDS = new Set(["audit_hash", "write_receipt", "created_at", "updated_at"]);

// Canonical, write-time projection used for the content-integrity hash. GENERIC over every own field
// (sorted for determinism) minus NON_CONTENT_FIELDS -- not a fixed allowlist -- so no consumed field
// can sit outside the hash.
export function canonicalMemoryForHash(m) {
  const out = {};
  for (const k of Object.keys(m).sort()) {
    if (NON_CONTENT_FIELDS.has(k)) continue;
    out[k] = m[k] ?? null;
  }
  return out;
}

export function memoryContentHash(m) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalMemoryForHash(m))).digest("hex")}`;
}

// Write-time attestation (review M1): an unforgeable receipt binding the record's FULL attested
// content (via its content hash, which includes the declared source_message_id) under a key held by
// the TRUSTED control plane (the runtime), NOT by record authors. A record that did not pass through
// the trusted write path -- e.g. one injected directly into the store, or whose source/content was
// re-pointed by store tampering -- cannot carry a valid receipt, so the read-time gate rejects it.
// This makes the declared source binding cryptographic rather than self-asserted.
export function memoryWriteReceipt(m, key) {
  return `hmac:${createHmac("sha256", String(key)).update(memoryContentHash(m)).digest("hex")}`;
}

export function verifyWriteReceipt(m, key) {
  return typeof m.write_receipt === "string" && m.write_receipt === memoryWriteReceipt(m, key);
}
