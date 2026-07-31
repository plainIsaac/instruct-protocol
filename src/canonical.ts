import { createHash } from "node:crypto";

/**
 * Deterministic JSON encoding used by protocol digests and receipt integrity.
 * Object keys are sorted by Unicode code point. Undefined object members are
 * omitted to match JSON object semantics; unsupported values elsewhere fail closed.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>(), "$");
}

export function protocolHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function encode(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`CANONICAL_NON_FINITE_NUMBER:${path}`);
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`CANONICAL_UNSUPPORTED_VALUE:${path}`);
  if (seen.has(value)) throw new Error(`CANONICAL_CYCLE:${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => encode(item, seen, `${path}[${index}]`)).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => {
      const child = object[key];
      return `${JSON.stringify(key)}:${encode(child, seen, `${path}.${key}`)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
