import { ProtocolError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import type { Destination, Guard, GuardedValue, JsonValue, PrivateHandle, Representation, Sensitivity, TransformationRecord } from "./types.js";

const rank: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, secret: 3 };
const unique = <T>(xs: T[]) => [...new Set(xs)];

export function defaultGuard(scope: string, sensitivity: Sensitivity = "public"): Guard {
  return { sensitivity, disclosures: [], provenance: [], sourceHandles: [], transformations: [], permittedOperations: sensitivity === "public" ? ["*"] : [], permittedDestinations: ["local"], scope, correlation: "single-use" };
}

export function guarded<T>(value: T, guard: Guard): GuardedValue<T> { return { kind: "guarded", value, guard: structuredClone(guard) }; }

export function mergeGuards(values: GuardedValue[], transform?: Omit<TransformationRecord, "inputProvenance" | "at">): Guard {
  if (!values.length) return defaultGuard("derived");
  const guards = values.map(v => v.guard);
  const sensitivity = guards.reduce((a, b) => rank[a] >= rank[b.sensitivity] ? a : b.sensitivity, "public" as Sensitivity);
  const destinations = guards.map(g => g.permittedDestinations).reduce((a, b) => intersectPermissions(a, b, destinationCovers));
  const provenance = unique(guards.flatMap(g => g.provenance));
  const record = transform ? [{ ...transform, inputProvenance: provenance, at: new Date().toISOString() }] : [];
  return {
    sensitivity, disclosures: unique(guards.flatMap(g => g.disclosures)), provenance,
    sourceHandles: unique(guards.flatMap(g => g.sourceHandles)), transformations: [...guards.flatMap(g => g.transformations), ...record],
    permittedOperations: guards.map(g => g.permittedOperations).reduce((a, b) => intersectPermissions(a, b, (grant, required) => grant === "*" || grant === required)),
    permittedDestinations: destinations, scope: guards[0]!.scope,
    expiresAt: earliest(values.flatMap(value => [value.guard.expiresAt, value.handle?.expiresAt])), correlation: "single-use"
  };
}

/** Pairwise intersection retains the narrower permission, never an empty-set fallback. */
function intersectPermissions<T extends string>(left: T[], right: T[], covers: (grant: T, required: T) => boolean): T[] {
  return unique(left.flatMap(a => right.flatMap(b => covers(a, b) ? [b] : covers(b, a) ? [a] : [])));
}

function destinationCovers(grant: Destination, required: Destination): boolean {
  return grant === required || ((grant === "local" || grant === "tool:*") && required.startsWith("tool:"));
}

// Timestamps may use different offsets, so compare instants rather than strings.
function earliest(values: (string | undefined)[]): string | undefined {
  return values.filter((v): v is string => Boolean(v)).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

export class HandleStore {
  readonly #values = new Map<string, { handle: PrivateHandle; value: GuardedValue }>();
  constructor(readonly scope: string) {}
  create(value: GuardedValue, type = "unknown"): GuardedValue {
    const id = `h_${randomUUID()}`; const handle: PrivateHandle = { id, type, scope: this.scope, expiresAt: value.guard.expiresAt };
    // Neither creator-owned values nor returned descriptors may alias authority.
    this.#values.set(id, structuredClone({ handle, value }));
    return structuredClone({ kind: "guarded", handle, guard: { ...value.guard, sourceHandles: unique([...value.guard.sourceHandles, id]), scope: this.scope } });
  }
  resolve(handle: PrivateHandle): GuardedValue {
    if (handle.scope !== this.scope) throw new ProtocolError("HANDLE_SCOPE_VIOLATION");
    const stored = this.#values.get(handle.id); if (!stored) throw new ProtocolError("HANDLE_NOT_FOUND");
    if (stored.handle.scope !== handle.scope || stored.handle.type !== handle.type) throw new ProtocolError("HANDLE_METADATA_MISMATCH");
    if (stored.handle.expiresAt && Date.parse(stored.handle.expiresAt) <= Date.now()) { this.#values.delete(handle.id); throw new ProtocolError("HANDLE_EXPIRED"); }
    if (stored.value.guard.correlation === "single-use") this.#values.delete(handle.id);
    return structuredClone(stored.value);
  }
}

export function remoteRepresentation(value: GuardedValue, representation: Representation): JsonValue {
  if (!value.guard.permittedDestinations.includes("remote")) {
    if (!value.handle) throw new ProtocolError("REMOTE_DISCLOSURE_DENIED");
    return { $handle: value.handle.id, type: value.handle.type };
  }
  if (representation === "value" && value.guard.sensitivity === "public") return value.value as JsonValue;
  const basis = value.handle?.id ?? JSON.stringify(value.value);
  if (representation === "pseudonym") return `p_${createHash("sha256").update(`${value.guard.scope}:${basis}`).digest("hex").slice(0, 12)}`;
  if (representation === "summary") return { type: value.handle?.type ?? typeof value.value, sensitivity: value.guard.sensitivity };
  if (value.handle) return { $handle: value.handle.id, type: value.handle.type };
  throw new ProtocolError("PRIVATE_VALUE_REQUIRES_HANDLE");
}

export function assertDestination(value: GuardedValue, destination: Destination): void {
  if (!value.guard.permittedDestinations.some(grant => destinationCovers(grant, destination))) throw new ProtocolError(`DESTINATION_DENIED:${destination}`);
}
