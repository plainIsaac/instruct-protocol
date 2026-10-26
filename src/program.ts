import { ProtocolError, errorCode } from "./errors.js";
import { ExecutionBudget } from "./execution-budget.js";
import type { AnalysisReport, Budget, CodeProgram, Effect, ExecutionMetrics, Grant, GuardedValue, JsonValue } from "./types.js";
import { effectAllowed } from "./analyze.js";
import { defaultGuard, guarded, mergeGuards } from "./guarded.js";
import { EventRecorder } from "./observability.js";
import { invokeTool, type ToolRegistry } from "./tools.js";
import { runLuaSandbox } from "./lua-sandbox.js";
import { analyzeLuaSource } from "./lua-analysis.js";

export interface ProgramRuntime {
  /** Internal shared run-wide resource ledger; counters remain local. */
  executionBudget?: ExecutionBudget;
  /** Implicit dependencies inherited from the caller's control flow. */
  guardContributors?: readonly GuardedValue[];
  inputs: Record<string, GuardedValue>;
  /** Effective authority for the program. Callers pass the declared ∩ granted capabilities. */
  grant: Grant;
  /** Declared effects; a Lua tool call must be permitted by both these and the grant. */
  declaredEffects?: Effect[];
  /** Tools reachable through `instruct.tool`. Without a registry every call is denied. */
  tools?: ToolRegistry;
  signal?: AbortSignal;
  simulate?: boolean;
  /** Reject effectful tools that are not process-isolated (production profile). */
  requireIsolatedEffects?: boolean;
  /** Receives attempted declared effects on execution entry, including failed/timed-out calls. Not proof of exact effects or rollback. */
  observedEffects?: Effect[];
  metrics?: ExecutionMetrics;
  recorder?: EventRecorder;
  parentNodeId?: string;
  /** Called after validation, immediately before a tool enters execute/simulate. */
  onToolInvoked?: () => void;
}

/**
 * Advisory static checks. The sandbox removes ambient APIs and meters execution at
 * runtime regardless of what this analysis concludes.
 */
export function analyzeProgram(program: CodeProgram, grant: Grant, tools?: ToolRegistry): AnalysisReport {
  const issues: AnalysisReport["issues"] = [];
  if (program.language !== "lua") issues.push({ severity: "error", code: "UNSUPPORTED_LANGUAGE", message: program.language });
  if (!grant.capabilities.includes("code:execute")) issues.push({ severity: "error", code: "CAPABILITY_DENIED", message: "code:execute" });
  issues.push(...analyzeLuaSource(program.source, grant, tools));
  return { valid: !issues.some(i => i.severity === "error"), issues, capabilities: ["code:execute"], effects: [] };
}

export async function executeProgram(program: CodeProgram, runtime: ProgramRuntime): Promise<GuardedValue> {
  const started = performance.now(); const recorder = runtime.recorder;
  recorder?.emit("program.analysis.started", runtime.parentNodeId);
  const analysis = analyzeProgram(program, runtime.grant, runtime.tools);
  recorder?.emit("program.analysis.completed", runtime.parentNodeId, { valid: analysis.valid, issueCount: analysis.issues.length });
  if (!analysis.valid) {
    const codes = analysis.issues.filter(i => i.severity === "error").map(i => i.code);
    recorder?.emit("program.denied", runtime.parentNodeId, { codes });
    throw new ProtocolError(`PROGRAM_DENIED:${codes.join(",")}`);
  }
  let budget: Budget;
  try { budget = restrictBudget(runtime.grant.budget, program.budget); }
  catch (error) { recorder?.emit("program.denied", runtime.parentNodeId, { codes: [errorCode(error, "INVALID_PROGRAM_BUDGET")] }); throw new ProtocolError("PROGRAM_DENIED:INVALID_PROGRAM_BUDGET"); }
  const ledger = runtime.executionBudget ?? new ExecutionBudget(budget, started);
  const deadline = Math.min(ledger.deadline, started + budget.maxDurationMs);
  let producedBytes = 0;
  const consumeOutput = (value: unknown) => {
    producedBytes += ledger.consumeOutput(value);
    if (producedBytes > budget.maxOutputBytes) throw new ProtocolError("OUTPUT_BUDGET_EXCEEDED");
  };
  // Everything the program has read. Lua cannot carry guards, so every tool argument
  // and the result conservatively inherit all of them.
  const contributors: GuardedValue[] = [...Object.values(runtime.inputs), ...(runtime.guardContributors ?? [])];
  const handles = new Map<string, GuardedValue>();
  for (const value of contributors) if (value.handle) handles.set(value.handle.id, value);
  const finished = new AbortController();
  const toolSignal = AbortSignal.any([finished.signal, ...(runtime.signal ? [runtime.signal] : [])]);
  let calls = 0; const inFlight = new Set<Promise<unknown>>();

  const callTool = (name: string, rawArgs: unknown): Promise<JsonValue> => {
    const call = invoke(name, rawArgs); inFlight.add(call);
    void call.catch(() => undefined).finally(() => inFlight.delete(call));
    return call;
  };
  const invoke = async (name: string, rawArgs: unknown): Promise<JsonValue> => {
    const toolStarted = performance.now(); const tool = runtime.tools?.get(name);
    // The requested name is program-supplied; only registered names reach events.
    const detail = { tool: tool?.name ?? null };
    try {
      if (toolSignal.aborted) throw new ProtocolError("EXECUTION_ABORTED");
      if (performance.now() >= deadline) throw new ProtocolError("PROGRAM_TIMEOUT");
      if (producedBytes >= budget.maxOutputBytes) throw new ProtocolError("OUTPUT_BUDGET_EXCEEDED");
      if (++calls > budget.maxToolCalls) throw new ProtocolError("TOOL_CALL_BUDGET_EXCEEDED");
      ledger.consumeToolCall();
      if (!tool) throw new ProtocolError("TOOL_NOT_FOUND");
      if (!runtime.grant.capabilities.includes(tool.capability)) throw new ProtocolError("TOOL_CAPABILITY_DENIED");
      if (tool.effects.some(e => !effectAllowed(e, runtime.grant.effects) || !effectAllowed(e, runtime.declaredEffects ?? runtime.grant.effects))) throw new ProtocolError("TOOL_EFFECT_DENIED");
      if (runtime.requireIsolatedEffects && tool.effects.length && tool.isolation !== "process") throw new ProtocolError("PRODUCTION_TOOL_NOT_ISOLATED");
      if (runtime.metrics) runtime.metrics.toolCalls++;
      recorder?.emit("program.tool.started", runtime.parentNodeId, detail);
      const taint = contributors.length ? mergeGuards(contributors) : defaultGuard("program");
      const args = toGuardedArguments(rawArgs, taint, handles);
      const output = await invokeTool(tool, args, {
        signal: AbortSignal.any([toolSignal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())))]),
        simulate: runtime.simulate ?? false, variables: Object.freeze({}), guardContributors: contributors
      }, deadline, () => {
        if (toolSignal.aborted) throw new ProtocolError("EXECUTION_ABORTED");
        if (performance.now() >= deadline) throw new ProtocolError("PROGRAM_TIMEOUT");
        runtime.observedEffects?.push(...tool.effects); runtime.onToolInvoked?.();
      });
      contributors.push(output); if (output.handle) handles.set(output.handle.id, output);
      consumeOutput(toLua(output));
      recorder?.emit("program.tool.completed", runtime.parentNodeId, detail, performance.now() - toolStarted);
      return toLua(output);
    } catch (error) {
      recorder?.emit("program.tool.failed", runtime.parentNodeId, { ...detail, code: errorCode(error, "TOOL_FAILED") }, performance.now() - toolStarted);
      throw error;
    }
  };

  try {
    recorder?.emit("program.started", runtime.parentNodeId, { language: program.language });
    const inputs = Object.fromEntries(Object.entries(runtime.inputs).map(([k, v]) => [k, toLua(v)]));
    const allocation = ledger.reserveInstructions(budget.maxInstructions);
    const { value } = await runLuaSandbox({
      source: program.source, inputs, signal: runtime.signal, callTool, deadline,
      maxInstructions: allocation.limit, onInstructions: allocation.settle, maxMemoryBytes: budget.maxMemoryBytes, maxDurationMs: budget.maxDurationMs
    });
    consumeOutput(value);
    // Instruction counts and output sizes depend on guarded data, so they stay out of events.
    recorder?.emit("program.completed", runtime.parentNodeId, { toolCalls: calls }, performance.now() - started);
    return guarded(value, contributors.length ? mergeGuards(contributors, { name: "sandboxed-lua", trusted: false, guarantees: [] }) : defaultGuard("program"));
  } catch (error) {
    // Without a final worker report, keep the child's still-unreported output allocation
    // consumed as well. A retry must not mint resources by timing out its predecessor.
    if (["PROGRAM_TIMEOUT", "SANDBOX_STARTUP_TIMEOUT", "SANDBOX_FAILED", "EXECUTION_ABORTED"].includes(errorCode(error, "LUA_RUNTIME_ERROR"))) {
      ledger.outputBytes = Math.max(0, ledger.outputBytes - Math.max(0, budget.maxOutputBytes - producedBytes));
    }
    recorder?.emit("program.failed", runtime.parentNodeId, { code: errorCode(error, "LUA_RUNTIME_ERROR") }, performance.now() - started);
    throw error;
  } finally {
    // Stop in-flight tools and wait for them, so every effect is recorded before the caller builds a receipt.
    // invokeTool bounds each call by the deadline, so this wait is finite.
    finished.abort(); await Promise.allSettled([...inFlight]);
  }
}

function toLua(value: GuardedValue): JsonValue {
  if (value.value !== undefined) return value.value as JsonValue;
  return value.handle ? { $handle: value.handle.id, type: value.handle.type } : null;
}

/** Lua passes handles back as `{ $handle = id }`; only handles this run has seen resolve to their guarded value. */
function toGuardedArguments(raw: unknown, taint: GuardedValue["guard"], handles: Map<string, GuardedValue>): Record<string, GuardedValue> {
  const entries = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.entries(raw) : [["value", raw] as const];
  return Object.fromEntries(entries.map(([key, value]) => {
    const handleId = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).$handle : undefined;
    if (typeof handleId === "string") {
      const known = handles.get(handleId); if (!known) throw new ProtocolError("TOOL_UNKNOWN_HANDLE");
      return [key, known];
    }
    return [key, guarded(value, taint)];
  }));
}

function restrictBudget(parent: Budget, requested?: Partial<Budget>): Budget {
  const result = { ...parent };
  for (const key of Object.keys(result) as (keyof Budget)[]) {
    const value = requested?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new ProtocolError(`INVALID_PROGRAM_BUDGET:${key}`);
      result[key] = Math.min(parent[key], value);
    }
  }
  return result;
}
