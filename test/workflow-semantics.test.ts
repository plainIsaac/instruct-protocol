import { describe, expect, it } from "vitest";
import {
  ToolRegistry, analyzeWorkflow, defaultGuard, guarded, mergeGuards, normalizeWorkflow, run,
  type Grant, type OrchestrationCapsule, type WorkflowProposal
} from "../src/index.js";

const budget = { maxDurationMs: 1_000, maxInstructions: 1_000, maxMemoryBytes: 1_000_000, maxOutputBytes: 1_000, maxToolCalls: 10, maxCallDepth: 10 };
const send = { type: "send", resource: "email", reversible: false };
const grant: Grant = { capabilities: ["tool:ok", "tool:fail", "tool:send", "tool:undo"], effects: [send, { type: "undo" }], disclosureDestinations: ["local", "remote"], budget };

function tools(log: string[] = [], options: { undoFails?: boolean } = {}) {
  const ok = (name: string, capability: string, effects = [] as typeof grant.effects) => ({
    name, capability, effects,
    async execute() { log.push(name); return guarded(name, { ...defaultGuard("t"), permittedDestinations: ["local", "remote"] as ("local" | "remote")[] }); }
  });
  return new ToolRegistry()
    .register(ok("ok", "tool:ok"))
    .register({ name: "fail", capability: "tool:fail", effects: [], async execute() { log.push("fail"); throw new Error("boom"); } })
    .register(ok("send", "tool:send", [send]))
    .register({ name: "undo", capability: "tool:undo", effects: [{ type: "undo" }], async execute() { log.push("undo"); if (options.undoFails) throw new Error("undo broke"); return guarded("undone", defaultGuard("t")); } });
}
function capsule(workflow: WorkflowProposal, capabilities = grant.capabilities, effects = grant.effects): OrchestrationCapsule {
  return { version: "0.1", id: "semantics", kind: "orchestration", intent: "semantics", capabilities, effects, disclosureBudget: { maxRemoteBytes: 500, allowedLabels: [] }, inputs: {}, workflow };
}
const types = (result: Awaited<ReturnType<typeof run>>) => result.receipt.events.map(event => event.type);

describe("denial receipts", () => {
  it("returns a denied receipt when the workflow cannot be resolved", async () => {
    const result = await run(capsule({ steps: [{ id: "a", tool: "does-not-exist" }] }), { tools: tools(), grant });
    expect(result.receipt.status).toBe("denied");
    expect(result.receipt.events.find(event => event.type === "run.denied")?.detail.code).toBe("UNKNOWN_TOOL");
    expect(JSON.stringify(result.receipt)).not.toContain("does-not-exist");
  });

  it("returns a denied receipt when analysis rejects the workflow", async () => {
    const result = await run(capsule({ steps: [{ id: "a", tool: "send" }] }, ["tool:send"], []), { tools: tools(), grant });
    expect(result.receipt.status).toBe("denied");
    expect(types(result)).toContain("workflow.denied");
  });

  it("returns a denied receipt for an ungranted capsule capability", async () => {
    const result = await run(capsule({ steps: [{ id: "a", tool: "ok" }] }, ["tool:ok", "tool:other"]), { tools: tools(), grant });
    expect(result.receipt.status).toBe("denied");
    expect(result.receipt.events.find(event => event.type === "run.denied")?.detail.code).toBe("CAPSULE_CAPABILITY_DENIED");
  });
});

describe("failure handling", () => {
  it.each([false, true])("does not compensate direct schema rejection (simulate=%s)", async (simulate) => {
    const log: string[] = [];
    const registry = tools(log).register({
      name: "numeric", capability: "tool:ok", effects: [],
      inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      async execute() { log.push("execute"); return guarded(1, defaultGuard("t")); },
      async simulate() { log.push("simulate"); return guarded(1, defaultGuard("t")); }
    });
    const result = await run(capsule({ steps: [
      { id: "a", tool: "numeric", arguments: { x: "bad" }, retry: { attempts: 1, compensate: "undo" } },
      { id: "undo", tool: "undo" }
    ] }), { tools: registry, grant, simulate });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.find(event => event.type === "node.failed")?.detail.code).toBe("TOOL_SCHEMA_INVALID");
    expect(log).toEqual([]);
    expect(types(result)).not.toContain("node.compensation.started");
    expect(result.receipt.metrics.toolCalls).toBe(1);
  });

  it.each([
    ['{ x = "bad" }', "TOOL_SCHEMA_INVALID"],
    ['{ x = { ["$handle"] = "unknown" } }', "TOOL_UNKNOWN_HANDLE"]
  ])("does not compensate Lua validation rejection: %s", async (args, code) => {
    const log: string[] = [];
    const registry = tools(log).register({
      name: "numeric", capability: "tool:ok", effects: [],
      inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      async execute() { log.push("execute"); return guarded(1, defaultGuard("t")); }
    });
    const capabilities = [...grant.capabilities, "code:execute"];
    const result = await run(capsule({ steps: [
      { id: "a", kind: "code", capabilities: ["tool:ok"],
        program: `function main(instruct) return instruct.tool("numeric", ${args}) end`,
        retry: { attempts: 1, compensate: "undo" } },
      { id: "undo", tool: "undo" }
    ] }, capabilities), { tools: registry, grant: { ...grant, capabilities } });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.find(event => event.type === "program.tool.failed")?.detail.code).toBe(code);
    expect(log).toEqual([]);
    expect(types(result)).not.toContain("node.compensation.started");
    expect(result.receipt.metrics.toolCalls).toBe(1);
  });

  it.each([
    ["tool", false], ["tool", true], ["code", false], ["code", true]
  ] as const)("compensates synchronous %s execution failure (simulate=%s)", async (kind, simulate) => {
    const log: string[] = [];
    const registry = tools(log).register({
      name: "syncFail", capability: "tool:fail", effects: [],
      execute() { log.push("execute"); throw new Error("sync failure"); },
      simulate() { log.push("simulate"); throw new Error("sync failure"); }
    });
    const capabilities = [...grant.capabilities, "code:execute"];
    const retry = { attempts: 1, compensate: "undo" };
    const action = kind === "tool" ? { id: "a", tool: "syncFail", retry } : {
      id: "a", kind: "code", capabilities: ["tool:fail"], retry,
      program: 'function main(instruct) return instruct.tool("syncFail", {}) end'
    };
    const result = await run(capsule({ steps: [action, { id: "undo", tool: "undo" }] }, capabilities),
      { tools: registry, grant: { ...grant, capabilities }, simulate });
    expect(log).toEqual([simulate ? "simulate" : "execute", "undo"]);
    expect(result.receipt.status).toBe("failed");
    expect(types(result)).toContain("node.compensated");
    expect(result.receipt.metrics.toolCalls).toBe(2);
  });

  it.each(["tool", "code"])("charges rejected %s calls against the workflow budget", async (kind) => {
    const log: string[] = [];
    const registry = tools(log).register({
      name: "numeric", capability: "tool:ok", effects: [],
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
      async execute() { log.push("execute"); return guarded(1, defaultGuard("t")); }
    });
    const capabilities = [...grant.capabilities, "code:execute"];
    const retry = { attempts: 1, compensate: "undo", recover: "after" };
    const action = kind === "tool" ? { id: "a", tool: "numeric", arguments: { x: "bad" }, retry } : {
      id: "a", kind: "code", capabilities: ["tool:ok"], retry,
      program: 'function main(instruct) return instruct.tool("numeric", { x = "bad" }) end'
    };
    const result = await run(capsule({ steps: [action, { id: "undo", tool: "undo" }, { id: "after", tool: "ok" }] }, capabilities),
      { tools: registry, grant: { ...grant, capabilities, budget: { ...budget, maxToolCalls: 1 } } });
    expect(log).toEqual([]);
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.find(event => event.type === "node.failed" && event.nodeId === "after")?.detail.code).toBe("TOOL_CALL_BUDGET_EXCEEDED");
    expect(result.receipt.metrics.toolCalls).toBe(1);
    expect(types(result)).not.toContain("node.compensation.started");
  });

  it("runs the compensation path, records it, and preserves the original failure", async () => {
    const log: string[] = [];
    const result = await run(capsule({ steps: [
      { id: "a", tool: "fail", retry: { attempts: 2, compensate: "undo" }, next: "done" },
      { id: "undo", tool: "undo" },
      { id: "done", type: "return", result: {} }
    ] }), { tools: tools(log), grant });
    expect(log).toEqual(["fail", "fail", "undo"]);
    expect(result.receipt.status).toBe("failed");
    expect(types(result)).toEqual(expect.arrayContaining(["node.compensation.started", "node.compensated", "workflow.failed"]));
    expect(result.receipt.metrics.retries).toBe(1);
  });

  it("records a failed compensation without masking the original failure", async () => {
    const result = await run(capsule({ steps: [
      { id: "a", tool: "fail", retry: { attempts: 1, compensate: "undo", recover: "done" } },
      { id: "undo", tool: "undo" },
      { id: "done", type: "return", result: {} }
    ] }), { tools: tools([], { undoFails: true }), grant });
    expect(types(result)).toEqual(expect.arrayContaining(["node.compensation.failed", "node.recovered"]));
    expect(result.receipt.status).toBe("completed");
  });

  it("rejects retrying an irreversible effect on a non-idempotent tool", async () => {
    const result = await run(capsule({ steps: [{ id: "a", tool: "send", retry: { attempts: 2 } }] }), { tools: tools(), grant });
    expect(result.receipt.status).toBe("denied");
    expect(result.receipt.events.find(event => event.type === "workflow.denied")?.detail.codes).toEqual(["UNSAFE_RETRY"]);
  });

  it("rejects retrying a code node that may call an irreversible tool", async () => {
    const result = await run(capsule({ steps: [{ id: "a", kind: "code", capabilities: ["tool:send"], program: "function main(ctx) return 1 end", retry: { attempts: 2 } }] }, [...grant.capabilities, "code:execute"]),
      { tools: tools(), grant: { ...grant, capabilities: [...grant.capabilities, "code:execute"] } });
    expect(result.receipt.events.find(event => event.type === "workflow.denied")?.detail.codes).toEqual(["UNSAFE_RETRY"]);
  });

  it("rejects a compensation path that re-enters normal flow", async () => {
    const log: string[] = [];
    const result = await run(capsule({ steps: [
      { id: "a", tool: "fail", retry: { attempts: 1, compensate: "undo", recover: "s" } },
      { id: "undo", tool: "undo", next: "s" },
      { id: "s", tool: "ok", next: "done" },
      { id: "done", type: "return", result: {} }
    ] }), { tools: tools(log), grant });
    expect(result.receipt.events.find(event => event.type === "workflow.denied")?.detail.codes).toEqual(["INVALID_COMPENSATION"]);
    expect(log).toEqual([]);
  });

  it("does not compensate when the failure happened before any tool ran", async () => {
    const log: string[] = [];
    const result = await run(capsule({ steps: [
      { id: "first", tool: "ok", next: "a" },
      { id: "a", tool: "fail", retry: { attempts: 1, compensate: "undo" } },
      { id: "undo", tool: "undo" }
    ] }), { tools: tools(log), grant: { ...grant, budget: { ...budget, maxToolCalls: 1 } } });
    expect(log).toEqual(["ok"]);
    expect(types(result)).not.toContain("node.compensation.started");
  });

  it("rejects unknown condition operators", async () => {
    const registry = tools();
    const { graph } = await normalizeWorkflow({ steps: [
      { id: "c", kind: "condition", condition: { left: 1, op: "matches", right: 1 }, then: "d", else: "d" },
      { id: "d", type: "return", result: {} }
    ] }, { tools: registry, capabilities: [], effects: [] });
    expect(analyzeWorkflow(graph, grant, registry).issues.map(issue => issue.code)).toContain("INVALID_CONDITION");
  });
});

describe("guard derivation and remote results", () => {
  it("keeps the earliest expiry across timestamp offsets", () => {
    const merged = mergeGuards([
      guarded(1, { ...defaultGuard("s"), expiresAt: "2026-01-01T10:00:00+05:00" }),
      guarded(2, { ...defaultGuard("s"), expiresAt: "2026-01-01T06:00:00Z" })
    ]);
    expect(merged.expiresAt).toBe("2026-01-01T10:00:00+05:00");
  });

  it("does not let result names collide in the remote result", async () => {
    const result = await run(capsule({ steps: [
      { id: "a", tool: "ok", assign: "x", next: "done" },
      { id: "done", type: "return", result: { "bad name": { $ref: "x" }, "also bad": "public" } }
    ] }), { tools: tools(), grant });
    expect(Object.keys(result.receipt.remoteResult as object)).toEqual(["result", "result_1"]);
  });

  it("withholds expired values", async () => {
    const expired = run({ ...capsule({ steps: [{ id: "done", type: "return", result: { old: { $ref: "old" } } }] }), inputs: {
      old: guarded("stale", { ...defaultGuard("s"), permittedDestinations: ["local", "remote"], expiresAt: new Date(0).toISOString() })
    } }, { tools: tools(), grant });
    expect((await expired).receipt.remoteResult).toEqual({ old: { withheld: true, type: "string" } });
  });
});
