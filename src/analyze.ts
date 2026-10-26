import type { AnalysisIssue, AnalysisReport, CanonicalWorkflow, Effect, Grant, WorkflowNode } from "./types.js";
import type { ToolDefinition, ToolRegistry } from "./tools.js";

const conditionOps = new Set(["eq", "neq", "exists", "truthy", "gt", "lt"]);
const effectKey = (e: Effect) => `${e.type}:${e.resource ?? "*"}`;
/** A broader grant (no resource) authorizes a narrower effect; never the reverse. */
export const effectAllowed = (effect: Effect, grants: Effect[]): boolean => grants.some(g => g.type === effect.type && (g.resource === undefined || g.resource === effect.resource));

export function analyzeWorkflow(graph: CanonicalWorkflow, grant: Grant, tools: ToolRegistry): AnalysisReport {
  const issues: AnalysisIssue[] = []; const capabilities = new Set<string>(); const effects: Effect[] = [];
  if (!graph.nodes[graph.entry]) issues.push(error("MISSING_ENTRY", `Entry node ${graph.entry} does not exist`));
  for (const node of Object.values(graph.nodes)) {
    for (const target of targets(node)) if (!graph.nodes[target]) issues.push(error("MISSING_TARGET", `Target ${target} does not exist`, node.id));
    if (node.retry && (!Number.isInteger(node.retry.attempts) || node.retry.attempts < 1 || node.retry.attempts > 10)) issues.push(error("INVALID_RETRY", "Retry attempts must be between 1 and 10", node.id));
    if (node.kind === "loop" && (!Number.isInteger(node.maxIterations) || node.maxIterations < 1 || node.maxIterations > 10_000)) issues.push(error("UNBOUNDED_LOOP", "Loop requires a bounded maxIterations", node.id));
    if (node.kind === "tool") {
      const tool = tools.get(node.tool); if (!tool) { issues.push(error("UNKNOWN_TOOL", node.tool, node.id)); continue; }
      capabilities.add(tool.capability); effects.push(...tool.effects);
    }
    if ((node.retry?.attempts ?? 1) > 1 && reachableTools(node, tools).some(t => !t.idempotent && t.effects.some(e => !e.reversible))) issues.push(error("UNSAFE_RETRY", "Retrying an irreversible effect requires an idempotent tool", node.id));
    if (node.kind === "condition" && !conditionOps.has(node.condition.op)) issues.push(error("INVALID_CONDITION", `Unknown operator ${String(node.condition.op)}`, node.id));
    if (node.kind === "code") { capabilities.add("code:execute"); node.capabilities.forEach(c => capabilities.add(c)); }
    if (node.kind === "parallel") {
      const branchEffects = node.branches.map(b => collectEffects(b, graph, tools, new Set()));
      const unsafe = branchEffects.flatMap(x => x).filter(e => !e.reversible).map(effectKey);
      if (new Set(unsafe).size !== unsafe.length) issues.push(error("UNSAFE_PARALLEL_EFFECT", "Parallel branches may perform the same irreversible effect", node.id));
    }
  }
  for (const cap of capabilities) {
    if (!graph.declaredCapabilities.includes(cap)) issues.push(error("UNDECLARED_CAPABILITY", cap));
    if (!grant.capabilities.includes(cap)) issues.push(error("CAPABILITY_DENIED", cap));
  }
  for (const effect of effects) {
    if (!effectAllowed(effect, graph.declaredEffects)) issues.push(error("UNDECLARED_EFFECT", effectKey(effect)));
    if (!effectAllowed(effect, grant.effects)) issues.push(error("EFFECT_DENIED", effectKey(effect)));
  }
  // This profile has root terminals only: nested results would otherwise be discarded.
  // Stop traversal at the enclosing boundary, including recovery edges and nested structures.
  for (const node of Object.values(graph.nodes)) {
    const paths = node.kind === "loop" ? [{ start: node.body, stop: node.id }] : node.kind === "parallel" ? node.branches.map(start => ({ start, stop: node.join })) : [];
    for (const { start, stop } of paths) {
      const pending = [start]; const seen = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!; if (id === stop || seen.has(id)) continue; seen.add(id);
        const child = graph.nodes[id]; if (!child) continue;
        if (child.kind === "terminal") { issues.push(error("NESTED_TERMINAL", "Terminal before a loop boundary or parallel join is unsupported", child.id)); break; }
        pending.push(...targets(child));
      }
    }
  }
  // Compensation must not re-enter normal flow (where it could repeat effects) or end the workflow.
  const normal = walk(graph.entry, graph, new Set(), false);
  for (const node of Object.values(graph.nodes)) if (node.retry?.compensate) {
    const path = walk(node.retry.compensate, graph);
    if ([...path].some(id => normal.has(id) || graph.nodes[id]?.kind === "terminal")) issues.push(error("INVALID_COMPENSATION", "Compensation paths must be separate from normal flow and must not terminate the workflow", node.id));
  }
  const reachable = walk(graph.entry, graph); for (const id of Object.keys(graph.nodes)) if (!reachable.has(id)) issues.push({ severity: "warning", code: "UNREACHABLE_NODE", message: id, nodeId: id });
  return { valid: !issues.some(i => i.severity === "error"), issues, capabilities: [...capabilities], effects: uniqueEffects(effects) };
}

function targets(n: WorkflowNode, compensation = true): string[] {
  const base = n.next ? [n.next] : []; if (n.retry?.recover) base.push(n.retry.recover); if (compensation && n.retry?.compensate) base.push(n.retry.compensate);
  if (n.kind === "condition") base.push(n.then, n.else); if (n.kind === "loop") base.push(n.body, n.after); if (n.kind === "parallel") base.push(...n.branches, n.join); if (n.kind === "join") base.push(n.next); return [...new Set(base)];
}
function walk(id: string, graph: CanonicalWorkflow, seen = new Set<string>(), compensation = true): Set<string> { if (seen.has(id) || !graph.nodes[id]) return seen; seen.add(id); for (const x of targets(graph.nodes[id]!, compensation)) walk(x, graph, seen, compensation); return seen; }
/** Tools a node may invoke: its own tool, or for a code node every registered tool its capabilities allow. */
function reachableTools(n: WorkflowNode, tools: ToolRegistry): ToolDefinition[] {
  if (n.kind === "tool") { const tool = tools.get(n.tool); return tool ? [tool] : []; }
  if (n.kind === "code") return tools.list().filter(t => n.capabilities.includes(t.capability));
  return [];
}
function collectEffects(id: string, graph: CanonicalWorkflow, tools: ToolRegistry, seen: Set<string>): Effect[] { if (seen.has(id)) return []; seen.add(id); const n = graph.nodes[id]; if (!n) return []; return [...reachableTools(n, tools).flatMap(t => t.effects), ...targets(n).flatMap(x => collectEffects(x, graph, tools, seen))]; }
function uniqueEffects(xs: Effect[]): Effect[] { return [...new Map(xs.map(x => [effectKey(x), x])).values()]; }
function error(code: string, message: string, nodeId?: string): AnalysisIssue { return { severity: "error", code, message, nodeId }; }
