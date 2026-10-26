import { ProtocolError } from "./errors.js";
import type { Budget } from "./types.js";

/** Host-local ledger. Never copy counters into events or receipts. */
export class ExecutionBudget {
  instructions: number;
  outputBytes: number;
  toolCalls: number;
  readonly deadline: number;
  constructor(readonly limits: Budget, started = performance.now()) {
    this.instructions = limits.maxInstructions; this.outputBytes = limits.maxOutputBytes; this.toolCalls = limits.maxToolCalls;
    this.deadline = started + limits.maxDurationMs;
  }
  check(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ProtocolError("EXECUTION_ABORTED");
    if (performance.now() >= this.deadline) throw new ProtocolError("WORKFLOW_TIMEOUT");
  }
  consumeToolCall(): void {
    if (this.toolCalls <= 0) throw new ProtocolError("TOOL_CALL_BUDGET_EXCEEDED");
    if (this.outputBytes <= 0) throw new ProtocolError("OUTPUT_BUDGET_EXCEEDED");
    this.toolCalls--;
  }
  consumeOutput(value: unknown): number {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? "null");
    const remaining = this.outputBytes; this.outputBytes = Math.max(0, remaining - bytes);
    if (bytes > remaining) throw new ProtocolError("OUTPUT_BUDGET_EXCEEDED");
    return bytes;
  }
  consumeInstructions(count = 1): void {
    if (count > this.instructions) throw new ProtocolError("INSTRUCTION_BUDGET_EXCEEDED");
    this.instructions -= count;
  }
  reserveInstructions(limit: number): { limit: number; settle: (used: number) => void } {
    const allocation = Math.min(limit, this.instructions);
    if (allocation <= 0) throw new ProtocolError("INSTRUCTION_BUDGET_EXCEEDED");
    this.instructions -= allocation;
    let settled = false;
    return { limit: allocation, settle: used => {
      if (settled) return; settled = true;
      this.instructions += allocation - Math.min(allocation, Math.max(0, Math.ceil(used)));
    } };
  }
}
