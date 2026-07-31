import type { CanonicalWorkflow, CodeProgram, ConditionExpression, Effect, RetryPolicy, ValueExpression, WorkflowNode, WorkflowProposal } from "./types.js";
import type { ToolRegistry } from "./tools.js";
import { canonicalJson, protocolHash } from "./canonical.js";

export interface NormalizationDecision { path: string; from: unknown; to: unknown; reason: string }
export interface NormalizationContext { tools: ToolRegistry; capabilities: string[]; effects: Effect[]; resolver?: IntentResolver }
export interface IntentResolver {
  resolveTool(name: string, available: string[]): Promise<string | undefined>;
  normalizeArguments(tool: string, args: unknown): Promise<Record<string, ValueExpression>>;
}
export interface NormalizationResult { graph: CanonicalWorkflow; decisions: NormalizationDecision[]; proposalHash: string; canonicalHash: string }

const id = (raw: Record<string, unknown>, index: number) => String(raw.id ?? raw.name ?? `step_${index + 1}`);
const argsOf = (raw: Record<string, unknown>) => (raw.arguments ?? raw.args ?? raw.with ?? {}) as Record<string, ValueExpression>;

export class DeterministicIntentResolver implements IntentResolver {
  constructor(private readonly tools: ToolRegistry) {}
  async resolveTool(name: string): Promise<string | undefined> { return this.tools.resolve(name)?.name; }
  async normalizeArguments(_tool: string, args: unknown): Promise<Record<string, ValueExpression>> {
    if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, ValueExpression>;
    return { value: args as ValueExpression };
  }
}

export async function normalizeWorkflow(proposal: WorkflowProposal, context: NormalizationContext): Promise<NormalizationResult> {
  const rawNodes = proposal.nodes ?? proposal.steps;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) throw new Error("WORKFLOW_HAS_NO_NODES");
  const resolver = context.resolver ?? new DeterministicIntentResolver(context.tools);
  const decisions: NormalizationDecision[] = []; const nodes: Record<string, WorkflowNode> = {};
  for (let index = 0; index < rawNodes.length; index++) {
    const item = rawNodes[index]; if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`INVALID_NODE:${index}`);
    const raw = item as Record<string, unknown>; const nodeId = id(raw, index); if (nodes[nodeId]) throw new Error(`DUPLICATE_NODE:${nodeId}`);
    const kind = String(raw.kind ?? raw.type ?? (raw.tool ? "tool" : raw.program ? "code" : raw.result ? "terminal" : "tool")).toLowerCase();
    const next = raw.next == null ? undefined : String(raw.next);
    const retry = normalizeRetry(raw.retry);
    if (kind === "tool" || kind === "call") {
      const requested = String(raw.tool ?? raw.action ?? ""); const tool = await resolver.resolveTool(requested, context.tools.list().map(t => t.name));
      if (!tool) throw new Error(`UNKNOWN_TOOL:${requested}`);
      if (tool !== requested) decisions.push({ path: `${nodeId}.tool`, from: requested, to: tool, reason: "local tool-name resolution" });
      const normalizedArgs = await resolver.normalizeArguments(tool, argsOf(raw));
      if (canonicalJson(normalizedArgs) !== canonicalJson(argsOf(raw))) decisions.push({ path: `${nodeId}.arguments`, from: argsOf(raw), to: normalizedArgs, reason: "local argument normalization" });
      nodes[nodeId] = { id: nodeId, kind: "tool", tool, arguments: normalizedArgs, assign: raw.assign == null ? undefined : String(raw.assign), next, retry };
    } else if (kind === "code") {
      const programRaw = raw.program as Record<string, unknown> | string;
      const program: CodeProgram = typeof programRaw === "string" ? { language: "lua", source: programRaw } : { language: "lua", source: String(programRaw?.source ?? ""), budget: programRaw?.budget as CodeProgram["budget"] };
      nodes[nodeId] = { id: nodeId, kind: "code", program, capabilities: asStrings(raw.capabilities), inputs: (raw.inputs ?? {}) as Record<string, ValueExpression>, assign: raw.assign == null ? undefined : String(raw.assign), next, retry };
    } else if (kind === "condition" || kind === "branch") {
      nodes[nodeId] = { id: nodeId, kind: "condition", condition: normalizeCondition(raw.condition ?? raw.when), then: String(raw.then), else: String(raw.else) };
    } else if (kind === "loop") {
      nodes[nodeId] = { id: nodeId, kind: "loop", items: raw.items as ValueExpression, item: String(raw.item ?? "item"), body: String(raw.body), after: String(raw.after), maxIterations: Number(raw.maxIterations ?? 100) };
    } else if (kind === "parallel") {
      nodes[nodeId] = { id: nodeId, kind: "parallel", branches: asStrings(raw.branches), join: String(raw.join) };
    } else if (kind === "join") {
      nodes[nodeId] = { id: nodeId, kind: "join", next: String(raw.next) };
    } else if (kind === "terminal" || kind === "return") {
      nodes[nodeId] = { id: nodeId, kind: "terminal", result: (raw.result ?? raw.value ?? {}) as Record<string, ValueExpression> };
    } else throw new Error(`UNKNOWN_NODE_KIND:${kind}`);
  }
  const entry = proposal.entry ?? Object.keys(nodes)[0]!;
  const graph: CanonicalWorkflow = { version: "0.1", entry, nodes, declaredCapabilities: [...context.capabilities], declaredEffects: structuredClone(context.effects) };
  return { graph, decisions, proposalHash: protocolHash(proposal), canonicalHash: protocolHash(graph) };
}

function normalizeRetry(raw: unknown): RetryPolicy | undefined {
  if (raw == null) return undefined; if (typeof raw === "number") return { attempts: raw };
  if (typeof raw !== "object") throw new Error("INVALID_RETRY_POLICY"); const x = raw as Record<string, unknown>;
  return { attempts: Number(x.attempts ?? x.count ?? 1), recover: x.recover == null ? undefined : String(x.recover), compensate: x.compensate == null ? undefined : String(x.compensate) };
}
function normalizeCondition(raw: unknown): ConditionExpression {
  if (typeof raw === "string") return { left: { $ref: raw.replace(/^\$?/, "") }, op: "truthy" };
  if (!raw || typeof raw !== "object") throw new Error("INVALID_CONDITION"); const x = raw as Record<string, unknown>;
  return { left: x.left as ValueExpression, op: String(x.op ?? "truthy") as ConditionExpression["op"], right: x.right as ValueExpression };
}
function asStrings(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)]; }
