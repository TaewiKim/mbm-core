export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : stableStringify(value), "utf8");
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function answerMatches(answer, oracle) {
  if (!oracle) {
    return false;
  }
  const normalize = (value) => String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
  const normalizedAnswer = normalize(answer);
  const normalizedOracle = normalize(oracle);
  if (normalizedAnswer === normalizedOracle || normalizedAnswer.includes(normalizedOracle)) {
    return true;
  }
  const answerTokens = normalizedAnswer.split(" ");
  const oracleTokens = normalizedOracle.split(" ").filter((token) => token.length > 0);
  let cursor = 0;
  for (const token of oracleTokens) {
    const index = answerTokens.indexOf(token, cursor);
    if (index === -1) {
      return false;
    }
    cursor = index + 1;
  }
  return oracleTokens.length > 0;
}

export function arrayTextIncludes(values, needle) {
  const haystack = values.map((value) => String(value).toLowerCase()).join("\n");
  return haystack.includes(String(needle).toLowerCase());
}

export function average(items, field) {
  return items.reduce((total, item) => total + (item.metrics[field] ?? item[field] ?? 0), 0) / items.length;
}
