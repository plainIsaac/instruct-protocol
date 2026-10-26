import { describe, expect, it } from "vitest";
import { analyzeWorkflow, executeWorkflow, ToolRegistry, guarded, defaultGuard, type CanonicalWorkflow, type Grant, type WorkflowNode } from "../src/index.js";

const grant: Grant = { capabilities: [], effects: [], disclosureDestinations: ["local", "remote"], budget: { maxDurationMs: 2000, maxInstructions: 10000, maxMemoryBytes: 4000000, maxOutputBytes: 10000, maxToolCalls: 10, maxCallDepth: 10 } };
const terminal: WorkflowNode = { id: "done", kind: "terminal", result: { answer: "PUBLIC_BRANCH" } };
function graph(nodes: WorkflowNode[], entry = nodes[0]!.id): CanonicalWorkflow { return { version: "0.1", entry, nodes: Object.fromEntries(nodes.map(n => [n.id, n])), declaredCapabilities: [], declaredEffects: [] }; }
const loop: WorkflowNode = { id: "loop", kind: "loop", items: [1], item: "i", body: "body", after: "done", maxIterations: 2 };

describe("binding identifiers", () => {
  it.each(["constructor", "toString", "__proto__"])("does not resolve inherited %s references", async name => {
    const g = graph([{ id: "select", kind: "condition", condition: { left: { $ref: name }, op: "truthy" }, then: "done", else: "done" }, terminal]);
    const result = await executeWorkflow(g, { grant, tools: new ToolRegistry(), inputs: {} });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.find(e => e.type === "workflow.failed")?.detail.code).toBe("UNKNOWN_REFERENCE");
  });
  it("uses own-only lookup for templates", async () => {
    const result = await executeWorkflow(graph([{ ...terminal, result: { answer: { $template: "{{constructor}}" } } }]), { grant, tools: new ToolRegistry(), inputs: {} });
    expect(result.receipt.events.find(e => e.type === "workflow.failed")?.detail.code).toBe("UNKNOWN_REFERENCE");
  });
  it.each(["constructor", "toString", "__proto__"])("preserves a real own %s binding across branch snapshots", async name => {
    const tools = new ToolRegistry().register({ name: "value", capability: "tool:value", effects: [], async execute() { return guarded("OWN_VALUE", defaultGuard("value")); } });
    const g = graph([{ id: "parallel", kind: "parallel", branches: ["assign"], join: "done" }, { id: "assign", kind: "tool", tool: "value", arguments: {}, assign: name, next: "done" }, { ...terminal, result: { answer: { $ref: name } } }]); g.declaredCapabilities = ["tool:value"];
    const result = await executeWorkflow(g, { grant: { ...grant, capabilities: g.declaredCapabilities }, tools, inputs: {} });
    expect(result.receipt.status).toBe("completed");
    expect(result.localResult.answer?.value).toBe("OWN_VALUE");
  });
});

describe("control-dependent outputs", () => {
  it("withholds remotely permitted public values selected by a confidential predicate", async () => {
    const g = graph([{ id: "select", kind: "condition", condition: { left: { $ref: "secret" }, op: "truthy" }, then: "done", else: "other" }, { ...terminal, result: { answer: { $ref: "yes" } } }, { ...terminal, id: "other", result: { answer: { $ref: "no" } } }]);
    const publicValue = (value: string) => guarded(value, { ...defaultGuard("public"), permittedDestinations: ["local", "remote"] });
    for (const secret of [true, false]) {
      const result = await executeWorkflow(g, { grant, tools: new ToolRegistry(), inputs: { secret: guarded(secret, defaultGuard("secret", "confidential")), yes: publicValue("PUBLIC_BRANCH"), no: publicValue("OTHER_BRANCH") } });
      expect(result.receipt.status).toBe("completed");
      expect(result.receipt.remoteResult).toEqual({ answer: { withheld: true, type: "string" } });
      expect(result.localResult.answer?.guard.sensitivity).toBe("confidential");
    }
  });

  it.each(["condition", "loop"])("does not disclose public constants selected by a secret %s", async kind => {
    const g = kind === "condition" ? graph([{ id: "select", kind: "condition", condition: { left: { $ref: "secret" }, op: "truthy" }, then: "done", else: "other" }, terminal, { ...terminal, id: "other", result: { answer: "OTHER_BRANCH" } }]) : graph([{ ...loop, items: { $ref: "secret" } }, { id: "body", kind: "condition", condition: { left: true, op: "truthy" }, then: "loop", else: "loop" }, terminal]);
    const result = await executeWorkflow(g, { grant, tools: new ToolRegistry(), inputs: { secret: guarded(kind === "loop" ? [1] : true, defaultGuard("secret", "secret")) } });
    expect(result.receipt.status).toBe("completed");
    expect(result.localResult.answer?.guard.sensitivity).toBe("secret");
    expect(JSON.stringify(result.receipt.remoteResult)).not.toContain("PUBLIC_BRANCH");
  });
});

describe("nested path terminal preflight", () => {
  it.each(["loop", "branch", "nested-loop", "recovery"])("rejects a terminal reachable inside %s before its boundary", async shape => {
    const nodes: WorkflowNode[] = [loop, terminal];
    if (shape === "loop") nodes.push({ ...terminal, id: "body" });
    if (shape === "branch") nodes.push({ id: "body", kind: "parallel", branches: ["done"], join: "loop" });
    if (shape === "nested-loop") nodes.push({ ...loop, id: "body", body: "done", after: "loop" });
    if (shape === "recovery") nodes.push({ id: "body", kind: "code", program: { language: "lua", source: "function main() error('x') end" }, inputs: {}, capabilities: [], next: "loop", retry: { attempts: 1, recover: "done" } });
    const g = graph(nodes); g.declaredCapabilities = shape === "recovery" ? ["code:execute"] : [];
    const result = await executeWorkflow(g, { grant: { ...grant, capabilities: g.declaredCapabilities }, tools: new ToolRegistry(), inputs: {} });
    expect(result.receipt.status).toBe("denied");
    expect(result.receipt.events.some(e => e.type === "workflow.completed")).toBe(false);
    expect(analyzeWorkflow(g, { ...grant, capabilities: g.declaredCapabilities }, new ToolRegistry()).issues.map(i => i.code)).toContain("NESTED_TERMINAL");
  });
  it("rejects compensation terminals reached through recovery", async () => {
    const g = graph([{ id: "action", kind: "code", program: { language: "lua", source: "function main() error('x') end" }, capabilities: [], inputs: {}, retry: { attempts: 1, compensate: "undo" } }, { id: "undo", kind: "code", program: { language: "lua", source: "function main() error('x') end" }, capabilities: [], inputs: {}, retry: { attempts: 1, recover: "done" } }, terminal]);
    g.declaredCapabilities = ["code:execute"];
    const result = await executeWorkflow(g, { grant: { ...grant, capabilities: g.declaredCapabilities }, tools: new ToolRegistry(), inputs: {} });
    expect(result.receipt.status).toBe("denied");
    expect(result.receipt.events.find(e => e.type === "workflow.denied")?.detail.codes).toContain("INVALID_COMPENSATION");
    expect(result.receipt.events.some(e => e.type === "workflow.completed")).toBe(false);
  });
  it("accepts a root recovery terminal", async () => {
    const g = graph([{ id: "action", kind: "code", program: { language: "lua", source: "function main() error('x') end" }, capabilities: [], inputs: {}, retry: { attempts: 1, recover: "done" } }, terminal]); g.declaredCapabilities = ["code:execute"];
    const result = await executeWorkflow(g, { grant: { ...grant, capabilities: g.declaredCapabilities }, tools: new ToolRegistry(), inputs: {} });
    expect(result.receipt.status).toBe("completed");
    expect(result.localResult.answer?.value).toBe("PUBLIC_BRANCH");
    expect(result.receipt.events.filter(e => e.type === "workflow.completed")).toHaveLength(1);
  });
  it("accepts a root terminal after structured loop and branch boundaries", async () => {
    const g = graph([loop, { id: "body", kind: "parallel", branches: ["branch"], join: "join" }, { id: "branch", kind: "condition", condition: { left: true, op: "truthy" }, then: "join", else: "join" }, { id: "join", kind: "join", next: "loop" }, terminal]);
    const result = await executeWorkflow(g, { grant, tools: new ToolRegistry(), inputs: {} });
    expect(result.receipt.status).toBe("completed");
    expect(result.localResult.answer?.value).toBe("PUBLIC_BRANCH");
    expect(result.receipt.events.filter(e => e.type === "workflow.completed")).toHaveLength(1);
  });
});
