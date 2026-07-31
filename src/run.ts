import type { ExecutionResult, Grant, GuardedValue, InstructionCapsule, JsonValue } from "./types.js";
import type { IntentResolver } from "./normalize.js";
import type { ToolRegistry } from "./tools.js";
import { normalizeWorkflow } from "./normalize.js";
import { executeWorkflow } from "./workflow.js";
import { executeProgram } from "./program.js";
import { createReceipt } from "./receipt.js";
import { remoteRepresentation } from "./guarded.js";
import { emptyMetrics, EventRecorder, round, type ProtocolObserver } from "./observability.js";
import { protocolHash } from "./canonical.js";
import { validateInstructionCapsule } from "./schemas.js";

export interface RunOptions { grant: Grant; tools: ToolRegistry; resolver?: IntentResolver; simulate?: boolean; signal?: AbortSignal; observer?: ProtocolObserver }
export async function run(capsule: InstructionCapsule, options: RunOptions): Promise<ExecutionResult> {
  const metrics = emptyMetrics(); const recorder = new EventRecorder(options.observer); recorder.emit("run.started", undefined, { capsuleId: capsule.id, kind: capsule.kind });
  const capsuleErrors = validateInstructionCapsule(capsule);
  if (capsuleErrors.length) throw new Error(`INVALID_CAPSULE:${capsuleErrors.join(";")}`);
  if (capsule.version !== "0.1") throw new Error("UNSUPPORTED_PROTOCOL_VERSION");
  if (capsule.capabilities.some(c => !options.grant.capabilities.includes(c))) throw new Error("CAPSULE_CAPABILITY_DENIED");
  const instructionHash = protocolHash(capsule);
  if (capsule.kind === "orchestration") {
    const normalizationStarted = performance.now(); recorder.emit("workflow.normalization.started");
    const normalized = await normalizeWorkflow(capsule.workflow, { tools: options.tools, capabilities: capsule.capabilities, effects: capsule.effects, resolver: options.resolver });
    metrics.normalizationDurationMs = round(performance.now() - normalizationStarted); recorder.emit("workflow.normalization.completed", undefined, { decisionCount: normalized.decisions.length }, metrics.normalizationDurationMs);
    return executeWorkflow(normalized.graph, { tools: options.tools, grant: options.grant, inputs: capsule.inputs, simulate: options.simulate, signal: options.signal, instructionHash, canonicalHash: normalized.canonicalHash, disclosureBudget: capsule.disclosureBudget, recorder, metrics });
  }
  const executionStarted = performance.now(); metrics.codeExecutions++; const value = await executeProgram(capsule.program, { inputs: capsule.inputs, grant: options.grant, recorder }); metrics.executionDurationMs = round(performance.now() - executionStarted);
  const localResult = { result: value }; let remote: JsonValue;
  try { if (value.guard.disclosures.some(label => !capsule.disclosureBudget.allowedLabels.includes(label))) throw new Error("LABEL_DENIED"); remote = remoteRepresentation(value, value.guard.sensitivity === "public" ? "value" : "handle"); if (Buffer.byteLength(JSON.stringify(remote)) > capsule.disclosureBudget.maxRemoteBytes) remote = { withheld: true, reason: "disclosure_budget" }; } catch { remote = { withheld: true }; }
  const receiptStarted = performance.now(); metrics.totalDurationMs = round(performance.now() - recorder.startedAt); const receipt = createReceipt({ instructionHash, status: "completed", events: recorder.events, metrics, remoteResult: { result: remote }, observedEffects: [] }); metrics.receiptDurationMs = round(performance.now() - receiptStarted); metrics.totalDurationMs = round(performance.now() - recorder.startedAt);
  return { localResult, receipt: createReceipt({ instructionHash, status: "completed", events: recorder.events, metrics, remoteResult: { result: remote }, observedEffects: [] }) };
}
