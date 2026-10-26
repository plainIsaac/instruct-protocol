import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { ExecutionBudget } from "../src/execution-budget.js";
import { runLuaSandbox } from "../src/lua-sandbox.js";
import { executeWorkflow, executeProgram, ToolRegistry, guarded, defaultGuard, type CanonicalWorkflow, type Grant, type WorkflowNode } from "../src/index.js";

const grant: Grant = { capabilities: ["code:execute", "tool:work"], effects: [], disclosureDestinations: ["local", "remote"], budget: { maxDurationMs: 5000, maxInstructions: 100000, maxMemoryBytes: 4000000, maxOutputBytes: 10000, maxToolCalls: 10, maxCallDepth: 10 } };
function graph(nodes: WorkflowNode[]): CanonicalWorkflow { return { version: "0.1", entry: nodes[0]!.id, nodes: Object.fromEntries(nodes.map(n => [n.id, n])), declaredCapabilities: grant.capabilities, declaredEffects: grant.effects }; }
const done: WorkflowNode = { id: "done", kind: "terminal", result: {} };
const code = (source = "function main() return 1 end"): Extract<WorkflowNode, { kind: "code" }> => ({ id: "code", kind: "code", program: { language: "lua", source }, capabilities: [], inputs: {}, next: "loop" });
const loop: WorkflowNode = { id: "loop", kind: "loop", items: Array(20).fill(1), item: "i", body: "code", after: "done", maxIterations: 20 };

describe("run-wide resource accounting", () => {
  it.each(["tool", "code"] as const)("rechecks the deadline at %s execution entry", async kind => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0); let calls = 0;
    try {
      const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [], async execute() { calls++; return guarded(1, defaultGuard("tool")); } });
      const action: WorkflowNode = kind === "tool" ? { id: "action", kind, tool: "work", arguments: {} } : { ...code("function main() return instruct.tool('work', {}) end"), capabilities: ["tool:work"], next: undefined };
      const result = await executeWorkflow(graph([action]), { grant, tools, inputs: {}, observer: { emit(event) { if (event.type === "tool.started" || event.type === "program.tool.started") clock.mockReturnValue(6000); } } });
      expect(result.receipt.status).toBe("failed"); expect(calls).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it("charges repeated workflow action attempts to the instruction budget", async () => {
    let calls = 0;
    const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [], async execute() { calls++; throw new Error("failed"); } });
    const result = await executeWorkflow(graph([{ id: "action", kind: "tool", tool: "work", arguments: {}, retry: { attempts: 3 } }]), { tools, inputs: {}, grant: { ...grant, budget: { ...grant.budget, maxInstructions: 1 } } });
    expect(result.receipt.status).toBe("failed"); expect(calls).toBe(1);
  });

  it("stops launching Lua tools after the child's output allocation is exhausted even through pcall", async () => {
    let calls = 0;
    const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [], async execute() { calls++; return guarded("x".repeat(80), defaultGuard("tool")); } });
    await expect(executeProgram({ language: "lua", source: "function main() for i = 1, 5 do pcall(instruct.tool, 'work', {}) end return 1 end", budget: { maxOutputBytes: 100 } }, { grant, inputs: {}, tools, executionBudget: new ExecutionBudget(grant.budget) })).rejects.toThrow("OUTPUT_BUDGET_EXCEEDED");
    expect(calls).toBe(2);
  });

  it("waits for worker termination before another serial child can start", async () => {
    let release!: () => void; let terminating!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { terminating = resolve; });
    const original = Worker.prototype.terminate;
    const spy = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function(this: Worker) {
      terminating(); return original.call(this).then(async status => { await gate; return status; });
    });
    let settled = false;
    const pending = runLuaSandbox({ source: "function main() return 1 end", inputs: {}, maxInstructions: 1000, maxMemoryBytes: 4000000, maxDurationMs: 1000, callTool: async () => 1 }).then(value => { settled = true; return value; });
    try { await entered; await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false); }
    finally { release(); await pending; spy.mockRestore(); }
  });

  it("retains a timed-out child's unreported instruction/output allocation", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const ledger = new ExecutionBudget(grant.budget);
      const pending = executeProgram({ language: "lua", source: "function main() return 1 end", budget: { maxDurationMs: 1000, maxInstructions: 200, maxOutputBytes: 100 } }, { grant, inputs: {}, executionBudget: ledger });
      clock.mockReturnValue(2000);
      await expect(pending).rejects.toThrow("PROGRAM_TIMEOUT");
      expect(ledger.instructions).toBe(grant.budget.maxInstructions - 200);
      expect(ledger.outputBytes).toBe(grant.budget.maxOutputBytes - 100);
    } finally { clock.mockRestore(); }
  });

  it.each(["tool", "code"] as const)("preserves attempted effects when %s expires after entry", async kind => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0); let writes = 0;
    try {
      const effect = { type: "write", resource: "fixture", reversible: true };
      const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [effect], async execute() { writes++; clock.mockReturnValue(6000); return new Promise(() => {}); } });
      const action: WorkflowNode = kind === "tool" ? { id: "action", kind, tool: "work", arguments: {} } : { ...code("function main() return instruct.tool('work', {}) end"), capabilities: ["tool:work"], next: undefined };
      const g = graph([action]); g.declaredEffects = [effect];
      const result = await executeWorkflow(g, { grant: { ...grant, effects: [effect] }, tools, inputs: {} });
      expect(result.receipt.status).toBe("failed"); expect(writes).toBe(1);
      expect(result.receipt.observedEffects).toEqual([effect]);
    } finally { clock.mockRestore(); }
  });

  it.each(["tool", "code"] as const)("preserves attempted declared effects when %s fails after entering execution", async kind => {
    const effect = { type: "write", resource: "fixture", reversible: true }; let writes = 0;
    const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [effect], async execute() { writes++; throw new Error("effect already happened"); } });
    const action: WorkflowNode = kind === "tool" ? { id: "action", kind, tool: "work", arguments: {} } : { ...code("function main() return instruct.tool('work', {}) end"), capabilities: ["tool:work"], next: undefined };
    const g = graph([action]); g.declaredEffects = [effect];
    const result = await executeWorkflow(g, { tools, inputs: {}, grant: { ...grant, effects: [effect] } });
    expect(writes).toBe(1);
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.observedEffects).toEqual([effect]);
  });

  it("includes startup in the original deadline and never launches an expired queued tool", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0); let calls = 0;
    try {
      const pending = runLuaSandbox({ source: "function main() return instruct.tool('work', {}) end", inputs: {}, maxInstructions: 1000, maxMemoryBytes: 4000000, maxDurationMs: 1000, callTool: async () => { calls++; return 1; } });
      // Move the host clock past the original deadline before VM startup finishes.
      clock.mockReturnValue(2000);
      await expect(pending).rejects.toThrow("PROGRAM_TIMEOUT");
      expect(calls).toBe(0);
    } finally { clock.mockRestore(); }
  });
  it("does not launch retry or recovery tools after caller cancellation", async () => {
    const controller = new AbortController(); let calls = 0;
    const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [], async execute() { calls++; controller.abort(); throw new Error("failed after cancellation"); } });
    const result = await executeWorkflow(graph([{ id: "action", kind: "tool", tool: "work", arguments: {}, retry: { attempts: 3, recover: "recovery" } }, { id: "recovery", kind: "tool", tool: "work", arguments: {} }]), { tools, inputs: {}, grant, signal: controller.signal });
    expect(result.receipt.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it.each(["Lua loop", "tool branches", "terminal"])("charges cumulative produced bytes for %s", async shape => {
    const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [], async execute() { return guarded("x".repeat(140), defaultGuard("tool")); } });
    const nodes: WorkflowNode[] = shape === "Lua loop" ? [loop, code("function main() return string.rep('x', 80) end"), done] : shape === "tool branches" ? [{ id: "parallel", kind: "parallel", branches: ["a", "b"], join: "done" }, ...["a", "b"].map(id => ({ id, kind: "tool" as const, tool: "work", arguments: {}, next: "done" })), done] : [{ ...done, result: { big: "x".repeat(250) } }];
    const result = await executeWorkflow(graph(nodes), { tools, inputs: {}, grant: { ...grant, budget: { ...grant.budget, maxOutputBytes: 200 } } });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.some(e => e.detail.code === "OUTPUT_BUDGET_EXCEEDED")).toBe(true);
  });

  it.each(["retry", "branches"])("does not replenish Lua instructions across %s", async shape => {
    let calls = 0;
    const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [], async execute() { calls++; return guarded(1, defaultGuard("tool")); } });
    const action = { ...code("function main() instruct.tool('work', {}) error('failed') end"), capabilities: ["tool:work"], next: undefined, retry: { attempts: 10 } };
    const nodes: WorkflowNode[] = shape === "retry" ? [action] : [{ id: "parallel", kind: "parallel", branches: ["a", "b", "c", "d"], join: "done" }, ...["a", "b", "c", "d"].map(id => ({ ...code(), id, next: "done" })), done];
    const result = await executeWorkflow(graph(nodes), { tools, inputs: {}, grant: { ...grant, budget: { ...grant.budget, maxInstructions: 300 } } });
    expect(result.receipt.status).toBe("failed");
    if (shape === "retry") expect(calls).toBeLessThan(10);
  });

  it("shares tool-call limits across failing Lua retries and recovery", async () => {
    let calls = 0;
    const tools = new ToolRegistry().register({ name: "work", capability: "tool:work", effects: [], async execute() { calls++; throw new Error("failed"); } });
    const action = { ...code("function main() return instruct.tool('work', {}) end"), capabilities: ["tool:work"], next: undefined, retry: { attempts: 3, recover: "recovery" } };
    const result = await executeWorkflow(graph([action, { id: "recovery", kind: "tool", tool: "work", arguments: {} }]), { tools, inputs: {}, grant: { ...grant, budget: { ...grant.budget, maxToolCalls: 2 } } });
    expect(result.receipt.status).toBe("failed"); expect(calls).toBe(2);
    expect(result.receipt.metrics.toolCalls).toBe(2);
  });

  it("charges short Lua executions below hook granularity to the shared instruction budget", async () => {
    const result = await executeWorkflow(graph([loop, code(), done]), { tools: new ToolRegistry(), inputs: {}, grant: { ...grant, budget: { ...grant.budget, maxInstructions: 300 } } });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.metrics.codeExecutions).toBeLessThan(20);
    expect(result.receipt.events.some(e => e.type === "program.failed" || e.type === "workflow.failed")).toBe(true);
  });
});
