export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Sensitivity = "public" | "internal" | "confidential" | "secret";
export type Destination = "local" | "remote" | `tool:${string}`;
export type Representation = "value" | "handle" | "pseudonym" | "summary";

export interface Guard {
  sensitivity: Sensitivity;
  disclosures: string[];
  provenance: string[];
  sourceHandles: string[];
  transformations: TransformationRecord[];
  permittedOperations: string[];
  permittedDestinations: Destination[];
  scope: string;
  expiresAt?: string;
  correlation: "single-use" | "session" | "persistent";
}

export interface TransformationRecord {
  name: string;
  trusted: boolean;
  guarantees: string[];
  inputProvenance: string[];
  at: string;
}

export interface PrivateHandle { id: string; type: string; scope: string; expiresAt?: string }
export interface GuardedValue<T = unknown> {
  kind: "guarded";
  value?: T;
  handle?: PrivateHandle;
  guard: Guard;
}

export interface Budget {
  maxDurationMs: number;
  maxInstructions: number;
  maxMemoryBytes: number;
  maxOutputBytes: number;
  maxToolCalls: number;
  maxCallDepth: number;
}

export interface Effect { type: string; resource?: string; reversible?: boolean }
export interface Grant {
  capabilities: string[];
  effects: Effect[];
  disclosureDestinations: Destination[];
  budget: Budget;
}

export interface CapsuleBase {
  version: "0.1";
  id: string;
  intent: string;
  capabilities: string[];
  effects: Effect[];
  disclosureBudget: { maxRemoteBytes: number; allowedLabels: string[] };
  inputs: Record<string, GuardedValue>;
  outputSchema?: JsonSchema;
}

export interface OrchestrationCapsule extends CapsuleBase {
  kind: "orchestration";
  workflow: WorkflowProposal;
}
export interface CodeCapsule extends CapsuleBase {
  kind: "code";
  program: CodeProgram;
}
export type InstructionCapsule = OrchestrationCapsule | CodeCapsule;

export interface WorkflowProposal {
  entry?: string;
  steps?: unknown[];
  nodes?: unknown[];
}

export interface RetryPolicy { attempts: number; recover?: string; compensate?: string }
export interface NodeBase { id: string; next?: string; retry?: RetryPolicy }
export interface ToolNode extends NodeBase { kind: "tool"; tool: string; arguments: Record<string, ValueExpression>; assign?: string }
export interface CodeNode extends NodeBase { kind: "code"; program: CodeProgram; capabilities: string[]; inputs: Record<string, ValueExpression>; assign?: string }
export interface ConditionNode extends NodeBase { kind: "condition"; condition: ConditionExpression; then: string; else: string }
export interface LoopNode extends NodeBase { kind: "loop"; items: ValueExpression; item: string; body: string; after: string; maxIterations: number }
export interface ParallelNode extends NodeBase { kind: "parallel"; branches: string[]; join: string }
export interface JoinNode extends NodeBase { kind: "join"; next: string }
export interface TerminalNode extends NodeBase { kind: "terminal"; result: Record<string, ValueExpression> }
export type WorkflowNode = ToolNode | CodeNode | ConditionNode | LoopNode | ParallelNode | JoinNode | TerminalNode;
export interface CanonicalWorkflow { version: "0.1"; entry: string; nodes: Record<string, WorkflowNode>; declaredCapabilities: string[]; declaredEffects: Effect[] }

export type ValueExpression = JsonValue | { $ref: string } | { $template: string };
export interface ConditionExpression { left: ValueExpression; op: "eq" | "neq" | "exists" | "truthy" | "gt" | "lt"; right?: ValueExpression }
export interface CodeProgram { language: "lua"; source: string; entry?: string; budget?: Partial<Budget> }

export interface JsonSchema { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; additionalProperties?: boolean }
export interface AnalysisIssue { severity: "error" | "warning"; code: string; message: string; nodeId?: string }
export interface AnalysisReport { valid: boolean; issues: AnalysisIssue[]; capabilities: string[]; effects: Effect[] }

export interface ExecutionEvent {
  sequence: number;
  type: string;
  timestamp: string;
  elapsedMs: number;
  durationMs?: number;
  nodeId?: string;
  detail: Record<string, JsonValue>;
}
export interface ExecutionMetrics {
  totalDurationMs: number;
  normalizationDurationMs: number;
  analysisDurationMs: number;
  executionDurationMs: number;
  receiptDurationMs: number;
  nodeCount: number;
  toolCalls: number;
  codeExecutions: number;
  retries: number;
  recoveries: number;
  failures: number;
  peakCallDepth: number;
}
export interface ExecutionReceipt {
  version: "0.1"; instructionHash: string; canonicalHash?: string; previousHash: string;
  receiptHash: string; status: "completed" | "failed" | "denied"; events: ExecutionEvent[]; metrics: ExecutionMetrics;
  remoteResult: unknown; observedEffects: Effect[];
}
export interface ExecutionResult { localResult: Record<string, GuardedValue>; receipt: ExecutionReceipt }
