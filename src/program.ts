import { ProtocolError, errorCode } from "./errors.js";
import type { AnalysisReport, Budget, CodeProgram, Effect, ExecutionMetrics, Grant, GuardedValue, JsonValue } from "./types.js";
import { effectAllowed } from "./analyze.js";
import { defaultGuard, guarded, mergeGuards } from "./guarded.js";
import { EventRecorder } from "./observability.js";
import { invokeTool, type ToolRegistry } from "./tools.js";
import { runLuaSandbox } from "./lua-sandbox.js";

export interface ProgramRuntime {
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
  /** Receives the declared effects of every tool the program invoked successfully. */
  observedEffects?: Effect[];
  metrics?: ExecutionMetrics;
  recorder?: EventRecorder;
  parentNodeId?: string;
  /** Called after validation, immediately before a tool enters execute/simulate. */
  onToolInvoked?: () => void;
}

const forbidden: [RegExp, string][] = [
  [/\b(require|dofile|loadfile|load|string\.dump|package|io|os|debug|collectgarbage)\b/, "FORBIDDEN_API"],
  [/\b(while|repeat|goto)\b/, "UNBOUNDED_CONTROL_FLOW"],
  [/["'](?:https?:|file:|\\\\|\/)/, "AMBIENT_RESOURCE_LITERAL"]
];

/**
 * Advisory static checks. The sandbox removes ambient APIs and meters execution at
 * runtime regardless of what this analysis concludes.
 */
export function analyzeProgram(program: CodeProgram, grant: Grant, tools?: ToolRegistry): AnalysisReport {
  const issues: AnalysisReport["issues"] = [];
  if (program.language !== "lua") issues.push({ severity: "error", code: "UNSUPPORTED_LANGUAGE", message: program.language });
  if (!grant.capabilities.includes("code:execute")) issues.push({ severity: "error", code: "CAPABILITY_DENIED", message: "code:execute" });
  for (const [pattern, code] of forbidden) if (pattern.test(program.source)) issues.push({ severity: "error", code, message: `Program matched ${pattern}` });
  for (const match of program.source.matchAll(/instruct\.tool\s*\(\s*["']([^"']+)["']/g)) {
    const capability = tools ? tools.get(match[1]!)?.capability : `tool:${match[1]}`;
    if (!capability) issues.push({ severity: "error", code: "UNKNOWN_TOOL", message: match[1]! });
    else if (!grant.capabilities.includes(capability)) issues.push({ severity: "error", code: "CAPABILITY_DENIED", message: capability });
  }
  for (const match of program.source.matchAll(/for\s+\w+\s*=\s*(-?\d+)\s*,\s*(-?\d+)/g)) if (Math.abs(Number(match[2]) - Number(match[1])) > 100_000) issues.push({ severity: "error", code: "LOOP_LIMIT_EXCEEDED", message: match[0] });
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
  // Reset when the VM is ready, matching the sandbox's own timer; tools cannot run before then.
  let deadline = performance.now() + budget.maxDurationMs;
  // Everything the program has read. Lua cannot carry guards, so every tool argument
  // and the result conservatively inherit all of them.
  const contributors: GuardedValue[] = Object.values(runtime.inputs);
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
      if (++calls > budget.maxToolCalls) throw new ProtocolError("TOOL_CALL_BUDGET_EXCEEDED");
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
        simulate: runtime.simulate ?? false, variables: Object.freeze({})
      }, deadline, runtime.onToolInvoked);
      contributors.push(output); if (output.handle) handles.set(output.handle.id, output);
      runtime.observedEffects?.push(...tool.effects);
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
    const { value } = await runLuaSandbox({
      source: program.source, inputs, signal: runtime.signal, callTool, onReady: () => { deadline = performance.now() + budget.maxDurationMs; },
      maxInstructions: budget.maxInstructions, maxMemoryBytes: budget.maxMemoryBytes, maxDurationMs: budget.maxDurationMs
    });
    const outputBytes = Buffer.byteLength(JSON.stringify(value));
    if (outputBytes > budget.maxOutputBytes) throw new ProtocolError("OUTPUT_BUDGET_EXCEEDED");
    // Instruction counts and output sizes depend on guarded data, so they stay out of events.
    recorder?.emit("program.completed", runtime.parentNodeId, { toolCalls: calls }, performance.now() - started);
    return guarded(value, contributors.length ? mergeGuards(contributors, { name: "sandboxed-lua", trusted: false, guarantees: [] }) : defaultGuard("program"));
  } catch (error) {
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
