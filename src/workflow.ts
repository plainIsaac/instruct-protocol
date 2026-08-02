import type { CanonicalWorkflow, ConditionExpression, Effect, ExecutionMetrics, ExecutionResult, Grant, GuardedValue, JsonValue, ValueExpression, WorkflowNode } from "./types.js";
import type { ToolContext, ToolRegistry } from "./tools.js";
import { analyzeWorkflow } from "./analyze.js";
import { defaultGuard, guarded, mergeGuards, remoteRepresentation } from "./guarded.js";
import { executeProgram } from "./program.js";
import { validateSchema } from "./schema.js";
import { validateGuardedValue } from "./schemas.js";
import { createReceipt, signReceipt, type ReceiptSigner } from "./receipt.js";
import { emptyMetrics, EventRecorder, round, type ProtocolObserver } from "./observability.js";

export interface WorkflowRuntime { tools: ToolRegistry; grant: Grant; inputs: Record<string, GuardedValue>; signal?: AbortSignal; simulate?: boolean; instructionHash?: string; canonicalHash?: string; disclosureBudget?: { maxRemoteBytes: number; allowedLabels: string[] }; observer?: ProtocolObserver; recorder?: EventRecorder; metrics?: ExecutionMetrics; receiptSigner?: ReceiptSigner }

export async function executeWorkflow(graph: CanonicalWorkflow, runtime: WorkflowRuntime): Promise<ExecutionResult> {
  const metrics = runtime.metrics ?? emptyMetrics(); const recorder = runtime.recorder ?? new EventRecorder(runtime.observer); recorder.emit("workflow.analysis.started");
  const analysisStarted = performance.now(); const analysis = analyzeWorkflow(graph, runtime.grant, runtime.tools); metrics.analysisDurationMs += round(performance.now() - analysisStarted);
  recorder.emit("workflow.analysis.completed", undefined, { valid: analysis.valid, issueCount: analysis.issues.length }, metrics.analysisDurationMs);
  if (!analysis.valid) { metrics.failures++; recorder.emit("workflow.denied", undefined, { codes: analysis.issues.filter(i => i.severity === "error").map(i => i.code) }); throw new Error(`WORKFLOW_DENIED:${analysis.issues.filter(i => i.severity === "error").map(i => i.code).join(",")}`); }
  const executionStarted = performance.now(); const deadline = executionStarted + runtime.grant.budget.maxDurationMs; const variables: Record<string, GuardedValue> = { ...runtime.inputs }; const effects: Effect[] = []; let calls = 0; let depth = 0; let steps = 0;
  const event = (type: string, nodeId?: string, detail: Record<string, JsonValue> = {}, durationMs?: number) => recorder.emit(type, nodeId, detail, durationMs);
  const toolContext = (): ToolContext => {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
    const signal = runtime.signal ? AbortSignal.any([runtime.signal, timeoutSignal]) : timeoutSignal;
    return { signal, simulate: runtime.simulate ?? false, variables: Object.freeze({ ...variables }) };
  };

  const runPath = async (start: string, stop?: string): Promise<Record<string, GuardedValue> | undefined> => {
    if (++depth > runtime.grant.budget.maxCallDepth) throw new Error("CALL_DEPTH_EXCEEDED"); metrics.peakCallDepth = Math.max(metrics.peakCallDepth, depth);
    let cursor: string | undefined = start;
    try {
      while (cursor && cursor !== stop) {
        if (++steps > runtime.grant.budget.maxInstructions) throw new Error("WORKFLOW_INSTRUCTION_BUDGET_EXCEEDED");
        if (performance.now() > deadline) throw new Error("WORKFLOW_TIMEOUT");
        if (runtime.signal?.aborted) throw new Error("EXECUTION_ABORTED");
        const node: WorkflowNode | undefined = graph.nodes[cursor]; if (!node) throw new Error(`MISSING_NODE:${cursor}`); metrics.nodeCount++; event("node.started", node.id, { kind: node.kind });
        if (node.kind === "terminal") {
          const result = Object.fromEntries(Object.entries(node.result).map(([k, v]) => [k, evaluate(v, variables)])); event("workflow.completed", node.id); return result;
        }
        if (node.kind === "condition") { cursor = test(node.condition, variables) ? node.then : node.else; event("condition.selected", node.id, { target: cursor ?? null }); continue; }
        if (node.kind === "join") { cursor = node.next; continue; }
        if (node.kind === "loop") {
          const items = evaluate(node.items, variables).value; if (!Array.isArray(items)) throw new Error(`LOOP_VALUE_NOT_ARRAY:${node.id}`);
          if (items.length > node.maxIterations) throw new Error(`LOOP_LIMIT_EXCEEDED:${node.id}`);
          for (const item of items) { variables[node.item] = guarded(item, evaluate(node.items, variables).guard); await runPath(node.body, node.id); }
          cursor = node.after; continue;
        }
        if (node.kind === "parallel") {
          // Deterministic scheduling avoids hidden races; branches receive snapshots and merge only disjoint writes.
          const baseline = new Set(Object.keys(variables)); const snapshots: Record<string, GuardedValue>[] = [];
          for (const branch of node.branches) { const before = { ...variables }; await runPath(branch, node.join); snapshots.push(Object.fromEntries(Object.entries(variables).filter(([k]) => !baseline.has(k) || variables[k] !== before[k]))); for (const key of Object.keys(variables)) delete variables[key]; Object.assign(variables, before); }
          const written = new Set<string>(); for (const snapshot of snapshots) for (const [k, v] of Object.entries(snapshot)) { if (written.has(k)) throw new Error(`PARALLEL_WRITE_CONFLICT:${k}`); written.add(k); variables[k] = v; }
          cursor = node.join; continue;
        }
        cursor = await executeAction(node, cursor);
      }
      return undefined;
    } finally { depth--; }
  };

  const executeAction = async (node: Extract<WorkflowNode, { kind: "tool" | "code" }>, cursor: string): Promise<string | undefined> => {
    const attempts = node.retry?.attempts ?? 1; let last: unknown;
    const actionStarted = performance.now();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        let output: GuardedValue;
        if (node.kind === "tool") {
          if (++calls > runtime.grant.budget.maxToolCalls) throw new Error("TOOL_CALL_BUDGET_EXCEEDED"); metrics.toolCalls++;
          const toolStarted = performance.now(); event("tool.started", node.id, { tool: node.tool, attempt });
          const tool = runtime.tools.get(node.tool)!; const args = Object.fromEntries(Object.entries(node.arguments).map(([k, v]) => [k, evaluate(v, variables)]));
          const plain = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v.value])); const schemaErrors = validateSchema(plain, tool.inputSchema);
          if (schemaErrors.length) throw new Error(`TOOL_SCHEMA_INVALID:${schemaErrors.join(";")}`);
          const operation = runtime.simulate && tool.simulate ? tool.simulate(args, toolContext()) : tool.execute(args, toolContext());
          output = await beforeDeadline(operation, deadline);
          const outputErrors = validateGuardedValue(output); if (outputErrors.length) throw new Error(`TOOL_OUTPUT_INVALID:${outputErrors.join(";")}`);
          const outputSchemaErrors = validateSchema(output.value, tool.outputSchema); if (outputSchemaErrors.length) throw new Error(`TOOL_OUTPUT_SCHEMA_INVALID:${outputSchemaErrors.join(";")}`);
          effects.push(...tool.effects); event("tool.completed", node.id, { tool: node.tool, attempt }, performance.now() - toolStarted);
        } else {
          const childCaps = ["code:execute", ...node.capabilities]; if (childCaps.some(c => !runtime.grant.capabilities.includes(c))) throw new Error("CODE_CAPABILITY_ESCALATION");
          const inputs = Object.fromEntries(Object.entries(node.inputs).map(([k, v]) => [k, evaluate(v, variables)]));
          metrics.codeExecutions++; output = await executeProgram(node.program, { inputs, grant: { ...runtime.grant, capabilities: childCaps }, recorder, parentNodeId: node.id });
        }
        if (node.assign) variables[node.assign] = output; event("node.completed", node.id, { attempt }, performance.now() - actionStarted); return node.next;
      } catch (error) { last = error; metrics.failures++; if (attempt > 1) metrics.retries++; event("node.failed", node.id, { attempt, code: sanitizeError(error) }, performance.now() - actionStarted); }
    }
    if (node.retry?.compensate && node.kind === "tool") { const tool = runtime.tools.get(node.tool); const value = node.assign ? variables[node.assign] : undefined; if (tool?.compensate && value) await tool.compensate(value, toolContext()); event("node.compensated", node.id); }
    if (node.retry?.recover) { metrics.recoveries++; event("node.recovered", node.id, { target: node.retry.recover }); return node.retry.recover; } throw last;
  };

  let localResult: Record<string, GuardedValue> = {}; let status: "completed" | "failed" = "completed";
  try { localResult = (await runPath(graph.entry)) ?? {}; } catch (error) { status = "failed"; event("workflow.failed", undefined, { code: sanitizeError(error) }); }
  metrics.executionDurationMs += round(performance.now() - executionStarted);
  let remoteResult: Record<string, JsonValue> = Object.fromEntries(Object.entries(localResult).map(([k, v]) => [safeName(k), safelyRepresent(v, runtime.disclosureBudget?.allowedLabels)]));
  const remoteBytes = Buffer.byteLength(JSON.stringify(remoteResult));
  if (remoteBytes > runtime.grant.budget.maxOutputBytes) { status = "failed"; remoteResult = { withheld: true, reason: "output_budget" }; }
  else if (runtime.disclosureBudget && remoteBytes > runtime.disclosureBudget.maxRemoteBytes) remoteResult = { withheld: true, reason: "disclosure_budget" };
  event("workflow.execution.completed", undefined, { status }, metrics.executionDurationMs); const receiptStarted = performance.now();
  createReceipt({ instructionHash: runtime.instructionHash ?? "unknown", canonicalHash: runtime.canonicalHash, status, events: recorder.events, metrics, remoteResult, observedEffects: effects }); metrics.receiptDurationMs = round(performance.now() - receiptStarted); metrics.totalDurationMs = round(performance.now() - recorder.startedAt);
  // Metrics are part of the hashed receipt, so rebuild once with final timing values.
  const unsigned = createReceipt({ instructionHash: runtime.instructionHash ?? "unknown", canonicalHash: runtime.canonicalHash, status, events: recorder.events, metrics, remoteResult, observedEffects: effects });
  return { localResult, receipt: runtime.receiptSigner ? await signReceipt(unsigned, runtime.receiptSigner) : unsigned };
}

function evaluate(expression: ValueExpression, variables: Record<string, GuardedValue>): GuardedValue {
  if (expression && typeof expression === "object" && !Array.isArray(expression)) {
    const special = expression as Record<string, unknown>;
    if (typeof special.$ref === "string") { const found = variables[special.$ref]; if (!found) throw new Error(`UNKNOWN_REFERENCE:${special.$ref}`); return found; }
    if (typeof special.$template === "string") {
      const refs: GuardedValue[] = []; const text = special.$template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m: string, name: string) => { const value = variables[name]; if (!value) throw new Error(`UNKNOWN_REFERENCE:${name}`); refs.push(value); return String(value.value ?? `[handle:${value.handle?.id}]`); });
      return guarded(text, refs.length ? mergeGuards(refs, { name: "template", trusted: false, guarantees: [] }) : defaultGuard("workflow"));
    }
  }
  return guarded(expression, defaultGuard("workflow", "public"));
}
function test(condition: ConditionExpression, variables: Record<string, GuardedValue>): boolean { const left = evaluate(condition.left, variables).value; const right = condition.right === undefined ? undefined : evaluate(condition.right, variables).value; switch (condition.op) { case "eq": return left === right; case "neq": return left !== right; case "exists": return left !== undefined && left !== null; case "truthy": return Boolean(left); case "gt": return Number(left) > Number(right); case "lt": return Number(left) < Number(right); } }
function sanitizeError(error: unknown): string { const message = error instanceof Error ? error.message : "UNKNOWN"; return message.split(":", 1)[0]!.replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 80); }
function safeName(name: string): string { return /^[a-zA-Z][\w.-]{0,63}$/.test(name) ? name : "result"; }
function safelyRepresent(value: GuardedValue, allowedLabels?: string[]): JsonValue { try { if (allowedLabels && value.guard.disclosures.some(label => !allowedLabels.includes(label))) throw new Error("LABEL_DENIED"); return remoteRepresentation(value, value.guard.sensitivity === "public" ? "value" : "handle"); } catch { return { withheld: true, type: value.handle?.type ?? typeof value.value }; } }

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("WORKFLOW_TIMEOUT");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("WORKFLOW_TIMEOUT")), remaining); })]);
  } finally { if (timer) clearTimeout(timer); }
}
