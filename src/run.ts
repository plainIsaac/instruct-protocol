import type { ExecutionResult, Grant, GuardedValue, InstructionCapsule, JsonValue } from "./types.js";
import type { IntentResolver } from "./normalize.js";
import type { ToolRegistry } from "./tools.js";
import { normalizeWorkflow } from "./normalize.js";
import { executeWorkflow } from "./workflow.js";
import { executeProgram } from "./program.js";
import { createReceipt, signReceipt, type ReceiptSigner } from "./receipt.js";
import { remoteRepresentation } from "./guarded.js";
import { CompositeObserver, emptyMetrics, EventRecorder, round, type ProtocolObserver } from "./observability.js";
import { referenceDigest } from "./canonical.js";
import { validateInstructionCapsule } from "./schemas.js";

export interface ProductionRunOptions {
  receiptSigner: ReceiptSigner;
  auditObserver: ProtocolObserver;
}
export interface RunOptions { grant: Grant; tools: ToolRegistry; resolver?: IntentResolver; simulate?: boolean; signal?: AbortSignal; observer?: ProtocolObserver; receiptSigner?: ReceiptSigner; production?: ProductionRunOptions }
export async function run(capsule: InstructionCapsule, options: RunOptions): Promise<ExecutionResult> {
  const capsuleErrors = validateInstructionCapsule(capsule);
  if (capsuleErrors.length) throw new Error(`INVALID_CAPSULE:${capsuleErrors.join(";")}`);
  if (capsule.version !== "0.1") throw new Error("UNSUPPORTED_PROTOCOL_VERSION");
  validateGrant(options.grant);
  if (options.production && (!options.production.receiptSigner || typeof options.production.auditObserver?.emit !== "function")) throw new Error("INVALID_PRODUCTION_PROFILE");
  const receiptSigner = options.production?.receiptSigner ?? options.receiptSigner;
  const observer = options.production ? new CompositeObserver([options.production.auditObserver, ...(options.observer ? [options.observer] : [])]) : options.observer;
  const metrics = emptyMetrics(); const recorder = new EventRecorder(observer); recorder.emit("run.started", undefined, { capsuleId: capsule.id, kind: capsule.kind });
  if (capsule.capabilities.some(c => !options.grant.capabilities.includes(c))) throw new Error("CAPSULE_CAPABILITY_DENIED");
  if (capsule.effects.some(effect => !effectAllowed(effect, options.grant.effects))) throw new Error("CAPSULE_EFFECT_DENIED");
  if (capsule.kind === "code" && !capsule.capabilities.includes("code:execute")) throw new Error("CAPSULE_CODE_CAPABILITY_UNDECLARED");
  const instructionHash = referenceDigest(capsule);
  if (capsule.kind === "orchestration") {
    const normalizationStarted = performance.now(); recorder.emit("workflow.normalization.started");
    const normalized = await normalizeWorkflow(capsule.workflow, { tools: options.tools, capabilities: capsule.capabilities, effects: capsule.effects, resolver: options.resolver });
    if (options.production) assertEffectfulToolsIsolated(normalized.graph, options.tools);
    metrics.normalizationDurationMs = round(performance.now() - normalizationStarted); recorder.emit("workflow.normalization.completed", undefined, { decisionCount: normalized.decisions.length }, metrics.normalizationDurationMs);
    return executeWorkflow(normalized.graph, { tools: options.tools, grant: options.grant, inputs: capsule.inputs, simulate: options.simulate, signal: options.signal, instructionHash, canonicalHash: normalized.canonicalHash, disclosureBudget: capsule.disclosureBudget, recorder, metrics, receiptSigner });
  }
  const executionStarted = performance.now(); metrics.codeExecutions++; const value = await executeProgram(capsule.program, { inputs: capsule.inputs, grant: options.grant, recorder }); metrics.executionDurationMs = round(performance.now() - executionStarted);
  const localResult = { result: value }; let remote: JsonValue;
  try { if (value.guard.disclosures.some(label => !capsule.disclosureBudget.allowedLabels.includes(label))) throw new Error("LABEL_DENIED"); remote = remoteRepresentation(value, value.guard.sensitivity === "public" ? "value" : "handle"); if (Buffer.byteLength(JSON.stringify(remote)) > capsule.disclosureBudget.maxRemoteBytes) remote = { withheld: true, reason: "disclosure_budget" }; } catch { remote = { withheld: true }; }
  const receiptStarted = performance.now(); metrics.totalDurationMs = round(performance.now() - recorder.startedAt); const receipt = createReceipt({ instructionHash, status: "completed", events: recorder.events, metrics, remoteResult: { result: remote }, observedEffects: [] }); metrics.receiptDurationMs = round(performance.now() - receiptStarted); metrics.totalDurationMs = round(performance.now() - recorder.startedAt);
  const unsigned = createReceipt({ instructionHash, status: "completed", events: recorder.events, metrics, remoteResult: { result: remote }, observedEffects: [] });
  return { localResult, receipt: receiptSigner ? await signReceipt(unsigned, receiptSigner) : unsigned };
}

function assertEffectfulToolsIsolated(graph: import("./types.js").CanonicalWorkflow, tools: ToolRegistry): void {
  for (const node of Object.values(graph.nodes)) if (node.kind === "tool") {
    const tool = tools.get(node.tool);
    if (tool?.effects.length && tool.isolation !== "process") throw new Error(`PRODUCTION_TOOL_NOT_ISOLATED:${tool.name}`);
  }
}

function effectAllowed(effect: { type: string; resource?: string }, granted: { type: string; resource?: string }[]): boolean {
  return granted.some(candidate => candidate.type === effect.type && (candidate.resource === undefined || candidate.resource === effect.resource));
}

function validateGrant(grant: Grant): void {
  if (!grant || !Array.isArray(grant.capabilities) || !Array.isArray(grant.effects) || !Array.isArray(grant.disclosureDestinations)) throw new Error("INVALID_GRANT");
  for (const [key, value] of Object.entries(grant.budget ?? {})) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_GRANT_BUDGET:${key}`);
  for (const key of ["maxDurationMs", "maxInstructions", "maxMemoryBytes", "maxOutputBytes", "maxToolCalls", "maxCallDepth"] as const)
    if (!Number.isSafeInteger(grant.budget?.[key]) || grant.budget[key] <= 0) throw new Error(`INVALID_GRANT_BUDGET:${key}`);
}
