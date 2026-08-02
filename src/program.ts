import type { AnalysisReport, Budget, CodeProgram, Grant, GuardedValue } from "./types.js";
import { defaultGuard, guarded, mergeGuards } from "./guarded.js";
import { EventRecorder } from "./observability.js";

export interface ProgramRuntime {
  inputs: Record<string, GuardedValue>;
  grant: Grant;
  invokeTool?: (name: string, args: unknown) => GuardedValue;
  recorder?: EventRecorder;
  parentNodeId?: string;
}

const forbidden: [RegExp, string][] = [
  [/\b(require|dofile|loadfile|load|string\.dump|package|io|os|debug|collectgarbage)\b/, "FORBIDDEN_API"],
  [/\b(while|repeat|goto)\b/, "UNBOUNDED_CONTROL_FLOW"],
  [/["'](?:https?:|file:|\\\\|\/)/, "AMBIENT_RESOURCE_LITERAL"]
];

export function analyzeProgram(program: CodeProgram, grant: Grant): AnalysisReport {
  const issues: AnalysisReport["issues"] = [];
  if (program.language !== "lua") issues.push({ severity: "error", code: "UNSUPPORTED_LANGUAGE", message: program.language });
  if (!grant.capabilities.includes("code:execute")) issues.push({ severity: "error", code: "CAPABILITY_DENIED", message: "code:execute" });
  for (const [pattern, code] of forbidden) if (pattern.test(program.source)) issues.push({ severity: "error", code, message: `Program matched ${pattern}` });
  for (const match of program.source.matchAll(/instruct\.tool\s*\(\s*["']([^"']+)["']/g)) if (!grant.capabilities.includes(`tool:${match[1]}`)) issues.push({ severity: "error", code: "CAPABILITY_DENIED", message: `tool:${match[1]}` });
  for (const match of program.source.matchAll(/for\s+\w+\s*=\s*(-?\d+)\s*,\s*(-?\d+)/g)) if (Math.abs(Number(match[2]) - Number(match[1])) > 100_000) issues.push({ severity: "error", code: "LOOP_LIMIT_EXCEEDED", message: match[0] });
  return { valid: !issues.some(i => i.severity === "error"), issues, capabilities: ["code:execute"], effects: [] };
}

export async function executeProgram(program: CodeProgram, runtime: ProgramRuntime): Promise<GuardedValue> {
  const started = performance.now(); runtime.recorder?.emit("program.analysis.started", runtime.parentNodeId);
  const analysis = analyzeProgram(program, runtime.grant); runtime.recorder?.emit("program.analysis.completed", runtime.parentNodeId, { valid: analysis.valid, issueCount: analysis.issues.length });
  if (!analysis.valid) { runtime.recorder?.emit("program.denied", runtime.parentNodeId, { codes: analysis.issues.map(i => i.code) }); throw new Error(`PROGRAM_DENIED:${analysis.issues.map(i => i.code).join(",")}`); }
  const budget = restrictBudget(runtime.grant.budget, program.budget);
  const { LuaFactory } = await import("wasmoon"); const lua = await new LuaFactory().createEngine({ traceAllocations: true, functionTimeout: budget.maxDurationMs });
  let instructions = 0; let calls = 0;
  try {
    runtime.recorder?.emit("program.started", runtime.parentNodeId, { language: program.language });
    const rawInputs = Object.fromEntries(Object.entries(runtime.inputs).map(([k, v]) => [k, v.value ?? (v.handle ? { $handle: v.handle.id, type: v.handle.type } : null)]));
    lua.global.set("__inputs", rawInputs);
    lua.global.set("__tick", () => { instructions += 1000; if (instructions > budget.maxInstructions) throw new Error("INSTRUCTION_BUDGET_EXCEEDED"); });
    lua.global.set("__tool", (name: string, args: unknown) => { calls++; if (calls > budget.maxToolCalls) throw new Error("TOOL_CALL_BUDGET_EXCEEDED"); if (!runtime.grant.capabilities.includes(`tool:${name}`)) throw new Error("TOOL_CAPABILITY_DENIED"); const out = runtime.invokeTool?.(name, args); return out?.value ?? (out?.handle ? { $handle: out.handle.id, type: out.handle.type } : null); });
    lua.global.setMemoryMax(budget.maxMemoryBytes);
    await lua.doString(`debug.sethook(__tick, "", 1000)\ninstruct = { inputs = __inputs, tool = __tool }\nio=nil; os=nil; package=nil; require=nil; dofile=nil; loadfile=nil; load=nil; debug=nil; collectgarbage=nil`);
    const result = await withTimeout(lua.doString(`${program.source}\nreturn main(instruct)`), budget.maxDurationMs);
    const encoded = JSON.stringify(result); if (Buffer.byteLength(encoded) > budget.maxOutputBytes) throw new Error("OUTPUT_BUDGET_EXCEEDED");
    runtime.recorder?.emit("program.completed", runtime.parentNodeId, { instructions, toolCalls: calls, outputBytes: Buffer.byteLength(encoded) }, performance.now() - started);
    return guarded(result, runtime.inputs && Object.keys(runtime.inputs).length ? mergeGuards(Object.values(runtime.inputs), { name: "sandboxed-lua", trusted: false, guarantees: [] }) : defaultGuard("program"));
  } catch (error) {
    runtime.recorder?.emit("program.failed", runtime.parentNodeId, { code: error instanceof Error ? error.message.split(":", 1)[0]!.slice(0, 80) : "UNKNOWN" }, performance.now() - started); throw error;
  } finally { lua.global.close(); }
}

function restrictBudget(parent: Budget, requested?: Partial<Budget>): Budget {
  const result = { ...parent };
  for (const key of Object.keys(result) as (keyof Budget)[]) {
    const value = requested?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_PROGRAM_BUDGET:${key}`);
      result[key] = Math.min(parent[key], value);
    }
  }
  return result;
}

async function withTimeout<T>(operation: Promise<T>, durationMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROGRAM_TIMEOUT")), durationMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
