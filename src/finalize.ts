import type { Destination, Effect, ExecutionMetrics, ExecutionReceipt, ExecutionResult, GuardedValue, JsonValue } from "./types.js";
import { remoteRepresentation } from "./guarded.js";
import { createReceipt, signReceipt, type ReceiptSigner } from "./receipt.js";
import { round, type EventRecorder } from "./observability.js";

export interface DisclosurePolicy {
  allowedLabels: string[];
  maxRemoteBytes: number;
  /** The grant's disclosure destinations. Raw values go remote only if both these and the guard permit it. */
  destinations: Destination[];
  maxOutputBytes: number;
}

/** Remote-safe representation of one value. Anything that cannot be represented safely is withheld. */
export function remoteSafeValue(value: GuardedValue, policy: Pick<DisclosurePolicy, "allowedLabels" | "destinations">): JsonValue {
  try {
    if (value.guard.disclosures.some(label => !policy.allowedLabels.includes(label))) throw new Error("LABEL_DENIED");
    if (value.guard.expiresAt && !(Date.parse(value.guard.expiresAt) > Date.now())) throw new Error("EXPIRED");
    const remote = policy.destinations.includes("remote") && value.guard.permittedDestinations.includes("remote");
    const effective = remote ? value : { ...value, guard: { ...value.guard, permittedDestinations: value.guard.permittedDestinations.filter(d => d !== "remote") } };
    return remoteRepresentation(effective, value.guard.sensitivity === "public" ? "value" : "handle");
  } catch { return { withheld: true, type: value.handle?.type ?? typeof value.value }; }
}

export interface FinalizeInput {
  recorder: EventRecorder;
  metrics: ExecutionMetrics;
  status: ExecutionReceipt["status"];
  instructionHash: string;
  canonicalHash?: string;
  localResult: Record<string, GuardedValue>;
  observedEffects: Effect[];
  policy: DisclosurePolicy;
  signer?: ReceiptSigner;
}

/** Applies disclosure and output budgets, then builds and optionally signs the receipt. */
export async function finalizeRun(input: FinalizeInput): Promise<ExecutionResult> {
  let status = input.status; const used = new Set<string>();
  let remoteResult: Record<string, JsonValue> = Object.fromEntries(Object.entries(input.localResult).map(([name, value], index) => {
    // Result names reach the model, so only plain identifiers pass and collisions get a positional name.
    let key = /^[a-zA-Z][\w.-]{0,63}$/.test(name) ? name : "result";
    if (used.has(key)) key = `result_${index}`; used.add(key);
    return [key, remoteSafeValue(value, input.policy)];
  }));
  const remoteBytes = Buffer.byteLength(JSON.stringify(remoteResult));
  if (remoteBytes > input.policy.maxOutputBytes) { if (status === "completed") status = "failed"; remoteResult = { withheld: true, reason: "output_budget" }; }
  else if (remoteBytes > input.policy.maxRemoteBytes) remoteResult = { withheld: true, reason: "disclosure_budget" };
  const fields = { instructionHash: input.instructionHash, canonicalHash: input.canonicalHash, status, events: input.recorder.events, metrics: input.metrics, remoteResult, observedEffects: input.observedEffects };
  const receiptStarted = performance.now(); createReceipt(fields);
  input.metrics.receiptDurationMs = round(performance.now() - receiptStarted); input.metrics.totalDurationMs = round(performance.now() - input.recorder.startedAt);
  // Metrics are part of the hashed receipt, so rebuild once with final timing values.
  const unsigned = createReceipt(fields);
  return { localResult: input.localResult, receipt: input.signer ? await signReceipt(unsigned, input.signer) : unsigned };
}
