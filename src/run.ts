import { ProtocolError, errorCode } from "./errors.js";
import type { CanonicalWorkflow, Effect, ExecutionResult, Grant, GuardedValue, InstructionCapsule } from "./types.js";
import type { IntentResolver } from "./normalize.js";
import type { ToolRegistry } from "./tools.js";
import { normalizeWorkflow } from "./normalize.js";
import { executeWorkflow } from "./workflow.js";
import { executeProgram } from "./program.js";
import type { ReceiptSigner } from "./receipt.js";
import { effectAllowed } from "./analyze.js";
import { finalizeRun } from "./finalize.js";
import { CompositeObserver, emptyMetrics, EventRecorder, round, type ProtocolObserver } from "./observability.js";
import { referenceDigest } from "./canonical.js";
import { validateInstructionCapsule } from "./schemas.js";

export interface ProductionRunOptions {
  receiptSigner: ReceiptSigner;
  auditObserver: ProtocolObserver;
}
export interface RunOptions { grant: Grant; tools: ToolRegistry; resolver?: IntentResolver; simulate?: boolean; signal?: AbortSignal; observer?: ProtocolObserver; receiptSigner?: ReceiptSigner; production?: ProductionRunOptions }
/**
 * Validates, authorizes, and executes one capsule. Malformed input (capsule, grant, or
 * production options) throws. Every other outcome returns a receipt whose status is
 * `denied` (authorization or interpretation prevented execution), `failed`, or `completed`.
 */
export async function run(capsule: InstructionCapsule, options: RunOptions): Promise<ExecutionResult> {
  const capsuleErrors = validateInstructionCapsule(capsule);
  if (capsuleErrors.length) throw new ProtocolError(`INVALID_CAPSULE:${capsuleErrors.join(";")}`);
  if (capsule.version !== "0.1") throw new ProtocolError("UNSUPPORTED_PROTOCOL_VERSION");
  validateGrant(options.grant);
  if (options.production && (!options.production.receiptSigner || typeof options.production.auditObserver?.emit !== "function")) throw new ProtocolError("INVALID_PRODUCTION_PROFILE");
  const receiptSigner = options.production?.receiptSigner ?? options.receiptSigner;
  const observer = options.production ? new CompositeObserver([options.production.auditObserver, ...(options.observer ? [options.observer] : [])]) : options.observer;
  const metrics = emptyMetrics(); const recorder = new EventRecorder(observer); recorder.emit("run.started", undefined, { capsuleId: capsule.id, kind: capsule.kind });
  const instructionHash = referenceDigest(capsule); const observedEffects: Effect[] = [];
  const finish = (status: "completed" | "failed" | "denied", localResult: Record<string, GuardedValue> = {}) => finalizeRun({
    recorder, metrics, status, instructionHash, localResult, observedEffects, signer: receiptSigner,
    policy: { ...capsule.disclosureBudget, destinations: options.grant.disclosureDestinations, maxOutputBytes: options.grant.budget.maxOutputBytes }
  });
  const deny = (code: string) => { recorder.emit("run.denied", undefined, { code }); return finish("denied"); };
  if (capsule.capabilities.some(c => !options.grant.capabilities.includes(c))) return deny("CAPSULE_CAPABILITY_DENIED");
  if (capsule.effects.some(effect => !effectAllowed(effect, options.grant.effects))) return deny("CAPSULE_EFFECT_DENIED");
  if (capsule.kind === "code" && !capsule.capabilities.includes("code:execute")) return deny("CAPSULE_CODE_CAPABILITY_UNDECLARED");
  if (capsule.kind === "orchestration") {
    const normalizationStarted = performance.now(); recorder.emit("workflow.normalization.started");
    let normalized: Awaited<ReturnType<typeof normalizeWorkflow>>;
    // Failure to resolve one unambiguous program is a denial, never partial execution.
    try { normalized = await normalizeWorkflow(capsule.workflow, { tools: options.tools, capabilities: capsule.capabilities, effects: capsule.effects, resolver: options.resolver }); }
    catch (error) { return deny(errorCode(error, "NORMALIZATION_FAILED")); }
    metrics.normalizationDurationMs = round(performance.now() - normalizationStarted); recorder.emit("workflow.normalization.completed", undefined, { decisionCount: normalized.decisions.length }, metrics.normalizationDurationMs);
    const unisolated = options.production ? unisolatedEffectfulTool(normalized.graph, options.tools) : undefined;
    if (unisolated) return deny("PRODUCTION_TOOL_NOT_ISOLATED");
    return executeWorkflow(normalized.graph, { tools: options.tools, grant: options.grant, inputs: capsule.inputs, simulate: options.simulate, signal: options.signal, instructionHash, canonicalHash: normalized.canonicalHash, disclosureBudget: capsule.disclosureBudget, recorder, metrics, receiptSigner, requireIsolatedEffects: Boolean(options.production) });
  }
  const executionStarted = performance.now(); metrics.codeExecutions++;
  try {
    // The program runs with declared ∩ granted authority; the capsule checks above guarantee declared ⊆ granted.
    const value = await executeProgram(capsule.program, {
      inputs: capsule.inputs, grant: { ...options.grant, capabilities: [...capsule.capabilities] }, declaredEffects: capsule.effects, tools: options.tools,
      signal: options.signal, simulate: options.simulate, requireIsolatedEffects: Boolean(options.production), observedEffects, metrics, recorder
    });
    metrics.executionDurationMs = round(performance.now() - executionStarted);
    return finish("completed", { result: value });
  } catch (error) {
    metrics.executionDurationMs = round(performance.now() - executionStarted); metrics.failures++;
    return finish(errorCode(error, "") === "PROGRAM_DENIED" ? "denied" : "failed");
  }
}

function unisolatedEffectfulTool(graph: CanonicalWorkflow, tools: ToolRegistry): string | undefined {
  for (const node of Object.values(graph.nodes)) if (node.kind === "tool") {
    const tool = tools.get(node.tool);
    if (tool?.effects.length && tool.isolation !== "process") return tool.name;
  }
  return undefined;
}

function validateGrant(grant: Grant): void {
  if (!grant || !Array.isArray(grant.capabilities) || !Array.isArray(grant.effects) || !Array.isArray(grant.disclosureDestinations)) throw new ProtocolError("INVALID_GRANT");
  for (const [key, value] of Object.entries(grant.budget ?? {})) if (!Number.isSafeInteger(value) || value <= 0) throw new ProtocolError(`INVALID_GRANT_BUDGET:${key}`);
  for (const key of ["maxDurationMs", "maxInstructions", "maxMemoryBytes", "maxOutputBytes", "maxToolCalls", "maxCallDepth"] as const)
    if (!Number.isSafeInteger(grant.budget?.[key]) || grant.budget[key] <= 0) throw new ProtocolError(`INVALID_GRANT_BUDGET:${key}`);
}
