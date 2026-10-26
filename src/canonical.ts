import { ProtocolError } from "./errors.js";
import { createHash } from "node:crypto";

/**
 * Deterministic JSON encoding used by this TypeScript reference implementation.
 * This is an implementation profile, not a mandatory protocol wire format.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>(), "$");
}

export function referenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function encode(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProtocolError(`CANONICAL_NON_FINITE_NUMBER:${path}`);
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") throw new ProtocolError(`CANONICAL_UNSUPPORTED_VALUE:${path}`);
  if (seen.has(value)) throw new ProtocolError(`CANONICAL_CYCLE:${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => encode(item, seen, `${path}[${index}]`)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProtocolError(`CANONICAL_UNSUPPORTED_OBJECT:${path}`);
    }
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).filter(key => object[key] !== undefined).sort(compareCodePoints).map(key => {
      const child = object[key];
      return `${JSON.stringify(key)}:${encode(child, seen, `${path}.${key}`)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0)!);
  const b = Array.from(right, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}
