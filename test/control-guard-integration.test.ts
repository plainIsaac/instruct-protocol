import { describe, expect, it } from "vitest";
import { defaultGuard, executeWorkflow, guarded, ToolRegistry, type CanonicalWorkflow, type Grant, type WorkflowNode } from "../src/index.js";

const grant: Grant = {
  capabilities: ["code:execute", "tool:write"], effects: [{ type: "write", reversible: true }], disclosureDestinations: ["local", "remote"],
  budget: { maxDurationMs: 2_000, maxInstructions: 50_000, maxMemoryBytes: 4_000_000, maxOutputBytes: 2_000, maxToolCalls: 4, maxCallDepth: 4 }
};

describe("integrated control dependency guards", () => {
  it.each([
    ["condition", "tool"], ["condition", "code"], ["loop", "tool"], ["loop", "code"]
  ] as const)("does not drop %s restrictions before a no-argument %s action", async (controlKind, kind) => {
    let calls = 0;
    const tools = new ToolRegistry().register({
      name: "writer", capability: "tool:write", effects: grant.effects,
      async execute() { calls++; return guarded("written", defaultGuard("control")); }
    });
    const next = controlKind === "loop" ? "choose" : "done";
    const action: WorkflowNode = kind === "tool"
      ? { id: "act", kind: "tool", tool: "writer", arguments: {}, next }
      : { id: "act", kind: "code", capabilities: ["tool:write"], inputs: {}, program: { language: "lua", source: "function main(ctx) return instruct.tool('writer', {}) end" }, next };
    const choose: WorkflowNode = controlKind === "loop"
      ? { id: "choose", kind: "loop", items: { $ref: "secret" }, item: "item", body: "act", after: "done", maxIterations: 1 }
      : { id: "choose", kind: "condition", condition: { left: { $ref: "secret" }, op: "truthy" }, then: "act", else: "done" };
    const graph: CanonicalWorkflow = {
      version: "0.1", entry: "choose", declaredCapabilities: grant.capabilities, declaredEffects: grant.effects,
      nodes: {
        choose,
        act: action, done: { id: "done", kind: "terminal", result: { ok: true } }
      }
    };
    const result = await executeWorkflow(graph, { tools, grant, inputs: {
      secret: guarded(controlKind === "loop" ? [true] : true, { ...defaultGuard("control", "secret"), permittedOperations: ["tool:read"] })
    } });
    expect(calls).toBe(0);
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.observedEffects).toEqual([]);
    expect(result.receipt.events.some(event => event.detail.code === "TOOL_OPERATION_DENIED")).toBe(true);
  });
});
