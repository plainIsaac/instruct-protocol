import { createHash, randomUUID } from "node:crypto";
import type { Destination, Guard, GuardedValue, JsonValue, PrivateHandle, Representation, Sensitivity, TransformationRecord } from "./types.js";

const rank: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, secret: 3 };
const unique = <T>(xs: T[]) => [...new Set(xs)];

export function defaultGuard(scope: string, sensitivity: Sensitivity = "public"): Guard {
  return { sensitivity, disclosures: [], provenance: [], sourceHandles: [], transformations: [], permittedOperations: [], permittedDestinations: ["local"], scope, correlation: "single-use" };
}

export function guarded<T>(value: T, guard: Guard): GuardedValue<T> { return { kind: "guarded", value, guard: structuredClone(guard) }; }

export function mergeGuards(values: GuardedValue[], transform?: Omit<TransformationRecord, "inputProvenance" | "at">): Guard {
  if (!values.length) return defaultGuard("derived");
  const guards = values.map(v => v.guard);
  const sensitivity = guards.reduce((a, b) => rank[a] >= rank[b.sensitivity] ? a : b.sensitivity, "public" as Sensitivity);
  const destinations = guards.map(g => g.permittedDestinations).reduce((a, b) => a.filter(x => b.includes(x)));
  const provenance = unique(guards.flatMap(g => g.provenance));
  const record = transform ? [{ ...transform, inputProvenance: provenance, at: new Date().toISOString() }] : [];
  return {
    sensitivity, disclosures: unique(guards.flatMap(g => g.disclosures)), provenance,
    sourceHandles: unique(guards.flatMap(g => g.sourceHandles)), transformations: [...guards.flatMap(g => g.transformations), ...record],
    permittedOperations: guards.map(g => g.permittedOperations).reduce((a, b) => a.filter(x => b.includes(x))),
    permittedDestinations: destinations, scope: guards[0]!.scope,
    expiresAt: guards.map(g => g.expiresAt).filter(Boolean).sort()[0], correlation: "single-use"
  };
}

export class HandleStore {
  readonly #values = new Map<string, GuardedValue>();
  constructor(readonly scope: string) {}
  create(value: GuardedValue, type = "unknown"): GuardedValue {
    const id = `h_${randomUUID()}`; const handle: PrivateHandle = { id, type, scope: this.scope, expiresAt: value.guard.expiresAt };
    this.#values.set(id, value);
    return { kind: "guarded", handle, guard: { ...value.guard, sourceHandles: unique([...value.guard.sourceHandles, id]), scope: this.scope } };
  }
  resolve(handle: PrivateHandle): GuardedValue {
    if (handle.scope !== this.scope) throw new Error("HANDLE_SCOPE_VIOLATION");
    if (handle.expiresAt && Date.parse(handle.expiresAt) <= Date.now()) throw new Error("HANDLE_EXPIRED");
    const value = this.#values.get(handle.id); if (!value) throw new Error("HANDLE_NOT_FOUND"); return value;
  }
}

export function remoteRepresentation(value: GuardedValue, representation: Representation): JsonValue {
  if (!value.guard.permittedDestinations.includes("remote")) {
    if (!value.handle) throw new Error("REMOTE_DISCLOSURE_DENIED");
    return { $handle: value.handle.id, type: value.handle.type };
  }
  if (representation === "value" && value.guard.sensitivity === "public") return value.value as JsonValue;
  const basis = value.handle?.id ?? JSON.stringify(value.value);
  if (representation === "pseudonym") return `p_${createHash("sha256").update(`${value.guard.scope}:${basis}`).digest("hex").slice(0, 12)}`;
  if (representation === "summary") return { type: value.handle?.type ?? typeof value.value, sensitivity: value.guard.sensitivity };
  if (value.handle) return { $handle: value.handle.id, type: value.handle.type };
  throw new Error("PRIVATE_VALUE_REQUIRES_HANDLE");
}

export function assertDestination(value: GuardedValue, destination: Destination): void {
  if (!value.guard.permittedDestinations.includes(destination)) throw new Error(`DESTINATION_DENIED:${destination}`);
}
