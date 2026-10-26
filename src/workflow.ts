import { ProtocolError, errorCode } from "./errors.js";
import { ExecutionBudget } from "./execution-budget.js";
import type { CanonicalWorkflow, ConditionExpression, Effect, ExecutionMetrics, ExecutionResult, Grant, GuardedValue, JsonValue, ValueExpression, WorkflowNode } from "./types.js";
import { invokeTool, type ToolContext, type ToolRegistry } from "./tools.js";
import { analyzeWorkflow } from "./analyze.js";
import { defaultGuard, guarded, mergeGuards } from "./guarded.js";
import { executeProgram } from "./program.js";
import { finalizeRun } from "./finalize.js";
import type { ReceiptSigner } from "./receipt.js";
import { emptyMetrics, EventRecorder, round, type ProtocolObserver } from "./observability.js";

export interface WorkflowRuntime { tools: ToolRegistry; grant: Grant; inputs: Record<string, GuardedValue>; signal?: AbortSignal; simulate?: boolean; instructionHash?: string; canonicalHash?: string; disclosureBudget?: { maxRemoteBytes: number; allowedLabels: string[] }; observer?: ProtocolObserver; recorder?: EventRecorder; metrics?: ExecutionMetrics; receiptSigner?: ReceiptSigner; requireIsolatedEffects?: boolean }

export async function executeWorkflow(graph: CanonicalWorkflow, runtime: WorkflowRuntime): Promise<ExecutionResult> {
  const metrics = runtime.metrics ?? emptyMetrics(); const recorder = runtime.recorder ?? new EventRecorder(runtime.observer); recorder.emit("workflow.analysis.started");
  const effects: Effect[] = [];
  const finish = (status: "completed" | "failed" | "denied", localResult: Record<string, GuardedValue>) => finalizeRun({
    recorder, metrics, status, localResult, observedEffects: effects, instructionHash: runtime.instructionHash ?? "unknown", canonicalHash: runtime.canonicalHash, signer: runtime.receiptSigner,
    policy: { allowedLabels: runtime.disclosureBudget?.allowedLabels ?? [], maxRemoteBytes: runtime.disclosureBudget?.maxRemoteBytes ?? runtime.grant.budget.maxOutputBytes, destinations: runtime.grant.disclosureDestinations, maxOutputBytes: runtime.grant.budget.maxOutputBytes }
  });
  const analysisStarted = performance.now(); const analysis = analyzeWorkflow(graph, runtime.grant, runtime.tools); metrics.analysisDurationMs += round(performance.now() - analysisStarted);
  recorder.emit("workflow.analysis.completed", undefined, { valid: analysis.valid, issueCount: analysis.issues.length }, metrics.analysisDurationMs);
  if (!analysis.valid) { recorder.emit("workflow.denied", undefined, { codes: analysis.issues.filter(i => i.severity === "error").map(i => i.code) }); return finish("denied", {}); }
  const executionStarted = performance.now(); const deadline = executionStarted + runtime.grant.budget.maxDurationMs; const variables: Record<string, GuardedValue> = Object.assign(Object.create(null), runtime.inputs); let depth = 0;
  const executionBudget = new ExecutionBudget(runtime.grant.budget, executionStarted);
  // Conservatively retain control taint for the rest of the run, including joins/recovery.
  const control = new Set<GuardedValue>();
  const controlled = (value: GuardedValue): GuardedValue => control.size ? { ...value, guard: mergeGuards([value, ...control]) } : value;
  const valueOf = (expression: ValueExpression) => controlled(evaluate(expression, variables));
  const event = (type: string, nodeId?: string, detail: Record<string, JsonValue> = {}, durationMs?: number) => recorder.emit(type, nodeId, detail, durationMs);
  const toolContext = (): ToolContext => {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
    const signal = runtime.signal ? AbortSignal.any([runtime.signal, timeoutSignal]) : timeoutSignal;
    return { signal, simulate: runtime.simulate ?? false, variables: Object.freeze({ ...variables }), guardContributors: [...control] };
  };

  const runPath = async (start: string, stop?: string): Promise<Record<string, GuardedValue> | undefined> => {
    if (++depth > runtime.grant.budget.maxCallDepth) throw new ProtocolError("CALL_DEPTH_EXCEEDED"); metrics.peakCallDepth = Math.max(metrics.peakCallDepth, depth);
    let cursor: string | undefined = start;
    try {
      while (cursor && cursor !== stop) {
        if (executionBudget.instructions <= 0) throw new ProtocolError("WORKFLOW_INSTRUCTION_BUDGET_EXCEEDED");
        executionBudget.consumeInstructions();
        if (performance.now() > deadline) throw new ProtocolError("WORKFLOW_TIMEOUT");
        if (runtime.signal?.aborted) throw new ProtocolError("EXECUTION_ABORTED");
        const node: WorkflowNode | undefined = graph.nodes[cursor]; if (!node) throw new ProtocolError(`MISSING_NODE:${cursor}`); metrics.nodeCount++; event("node.started", node.id, { kind: node.kind });
        if (node.kind === "terminal") {
          const result = Object.fromEntries(Object.entries(node.result).map(([k, v]) => [k, valueOf(v)]));
          executionBudget.consumeOutput(Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.value ?? v.handle ?? null])));
          event("workflow.completed", node.id); return result;
        }
        if (node.kind === "condition") {
          control.add(evaluate(node.condition.left, variables));
          if (node.condition.right !== undefined) control.add(evaluate(node.condition.right, variables));
          cursor = test(node.condition, variables) ? node.then : node.else; event("condition.selected", node.id, { target: cursor ?? null }); continue;
        }
        if (node.kind === "join") { cursor = node.next; continue; }
        if (node.kind === "loop") {
          const collection = evaluate(node.items, variables); control.add(collection); const items = collection.value; if (!Array.isArray(items)) throw new ProtocolError(`LOOP_VALUE_NOT_ARRAY:${node.id}`);
          if (items.length > node.maxIterations) throw new ProtocolError(`LOOP_LIMIT_EXCEEDED:${node.id}`);
          for (const item of items) { variables[node.item] = guarded(item, controlled(collection).guard); await runPath(node.body, node.id); }
          cursor = node.after; continue;
        }
        if (node.kind === "parallel") {
          // Deterministic scheduling avoids hidden races; branches receive snapshots and merge only disjoint writes.
          const baseline = new Set(Object.keys(variables)); const snapshots: Record<string, GuardedValue>[] = [];
          for (const branch of node.branches) { const before = { ...variables }; await runPath(branch, node.join); snapshots.push(Object.fromEntries(Object.entries(variables).filter(([k]) => !baseline.has(k) || variables[k] !== before[k]))); for (const key of Object.keys(variables)) delete variables[key]; Object.assign(variables, before); }
          const written = new Set<string>(); for (const snapshot of snapshots) for (const [k, v] of Object.entries(snapshot)) { if (written.has(k)) throw new ProtocolError(`PARALLEL_WRITE_CONFLICT:${k}`); written.add(k); variables[k] = v; }
          cursor = node.join; continue;
        }
        cursor = await executeAction(node);
      }
      return undefined;
    } finally { depth--; }
  };

  const executeAction = async (node: Extract<WorkflowNode, { kind: "tool" | "code" }>): Promise<string | undefined> => {
    const attempts = node.retry?.attempts ?? 1; let last: unknown; let invoked = false;
    const actionStarted = performance.now();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      executionBudget.check(runtime.signal);
      if (attempt > 1) { executionBudget.consumeInstructions(); metrics.retries++; }
      try {
        let output: GuardedValue;
        if (node.kind === "tool") {
          executionBudget.consumeToolCall(); metrics.toolCalls++;
          const toolStarted = performance.now(); event("tool.started", node.id, { tool: node.tool, attempt });
          const tool = runtime.tools.get(node.tool)!; const args = Object.fromEntries(Object.entries(node.arguments).map(([k, v]) => [k, valueOf(v)]));
          output = await invokeTool(tool, args, toolContext(), deadline, () => { executionBudget.check(runtime.signal); invoked = true; effects.push(...tool.effects); });
          executionBudget.consumeOutput(output.value ?? output.handle ?? null); event("tool.completed", node.id, { tool: node.tool, attempt }, performance.now() - toolStarted);
        } else {
          const childCaps = ["code:execute", ...node.capabilities]; if (childCaps.some(c => !runtime.grant.capabilities.includes(c))) throw new ProtocolError("CODE_CAPABILITY_ESCALATION");
          const inputs = Object.fromEntries(Object.entries(node.inputs).map(([k, v]) => [k, valueOf(v)]));
          // Child execution uses the same cumulative ledger and absolute run deadline.
          const remaining = { ...runtime.grant.budget, maxDurationMs: Math.max(1, Math.floor(deadline - performance.now())), maxToolCalls: executionBudget.toolCalls };
          metrics.codeExecutions++;
          output = await executeProgram(node.program, {
            inputs, grant: { ...runtime.grant, capabilities: childCaps, budget: remaining }, declaredEffects: graph.declaredEffects, tools: runtime.tools,
            signal: runtime.signal, simulate: runtime.simulate, requireIsolatedEffects: runtime.requireIsolatedEffects, observedEffects: effects, metrics, recorder, parentNodeId: node.id, executionBudget,
            onToolInvoked: () => { invoked = true; }, guardContributors: [...control]
          });
        }
        if (node.assign) variables[node.assign] = controlled(output); event("node.completed", node.id, { attempt }, performance.now() - actionStarted); return node.next;
      } catch (error) { last = error; metrics.failures++; event("node.failed", node.id, { attempt, code: errorCode(error, node.kind === "tool" ? "TOOL_FAILED" : "PROGRAM_FAILED") }, performance.now() - actionStarted); }
    }
    // Compensation is a separate, statically authorized path, run only if a tool was actually invoked.
    // Its outcome is recorded and never masks the original failure.
    if (node.retry?.compensate && invoked) {
      event("node.compensation.started", node.id, { target: node.retry.compensate });
      try { await runPath(node.retry.compensate); event("node.compensated", node.id); }
      catch (error) { metrics.failures++; event("node.compensation.failed", node.id, { code: errorCode(error, "COMPENSATION_FAILED") }); }
    }
    if (node.retry?.recover) { metrics.recoveries++; event("node.recovered", node.id, { target: node.retry.recover }); return node.retry.recover; } throw last;
  };

  let localResult: Record<string, GuardedValue> = {}; let status: "completed" | "failed" = "completed";
  try { localResult = (await runPath(graph.entry)) ?? {}; } catch (error) { status = "failed"; event("workflow.failed", undefined, { code: errorCode(error, "WORKFLOW_FAILED") }); }
  metrics.executionDurationMs += round(performance.now() - executionStarted);
  event("workflow.execution.completed", undefined, { status }, metrics.executionDurationMs);
  return finish(status, localResult);
}

function evaluate(expression: ValueExpression, variables: Record<string, GuardedValue>): GuardedValue {
  if (expression && typeof expression === "object" && !Array.isArray(expression)) {
    const special = expression as Record<string, unknown>;
    if (typeof special.$ref === "string") { if (!Object.hasOwn(variables, special.$ref)) throw new ProtocolError(`UNKNOWN_REFERENCE:${special.$ref}`); return variables[special.$ref]!; }
    if (typeof special.$template === "string") {
      const refs: GuardedValue[] = []; const text = special.$template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m: string, name: string) => {
        if (!Object.hasOwn(variables, name)) throw new ProtocolError(`UNKNOWN_REFERENCE:${name}`); const value = variables[name]!; refs.push(value);
        if (value.value === undefined) return `[handle:${value.handle?.id}]`;
        return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
      });
      return guarded(text, refs.length ? mergeGuards(refs, { name: "template", trusted: false, guarantees: [] }) : defaultGuard("workflow"));
    }
  }
  return guarded(expression, defaultGuard("workflow", "public"));
}
function test(condition: ConditionExpression, variables: Record<string, GuardedValue>): boolean { const left = evaluate(condition.left, variables).value; const right = condition.right === undefined ? undefined : evaluate(condition.right, variables).value; switch (condition.op) { case "eq": return left === right; case "neq": return left !== right; case "exists": return left !== undefined && left !== null; case "truthy": return Boolean(left); case "gt": return Number(left) > Number(right); case "lt": return Number(left) < Number(right); } }
