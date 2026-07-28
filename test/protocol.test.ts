import { describe, expect, it } from "vitest";
import {
  BufferedObserver, CompositeObserver, HandleStore, JsonLogObserver, ToolRegistry, defaultGuard, guarded, mergeGuards, normalizeWorkflow,
  analyzeWorkflow, executeWorkflow, analyzeProgram, verifyReceipt, run,
  type Grant, type OrchestrationCapsule, type ToolDefinition
} from "../src/index.js";

const budget = { maxDurationMs: 1_000, maxInstructions: 100_000, maxMemoryBytes: 8_000_000, maxOutputBytes: 10_000, maxToolCalls: 20, maxCallDepth: 20 };
const grant: Grant = { capabilities: ["tool:search", "tool:draft", "code:execute"], effects: [{ type: "draft", resource: "message", reversible: true }], disclosureDestinations: ["local"], budget };

function fixtures() {
  const tools = new ToolRegistry(); const secret = "SEED-SECRET-7492";
  tools.register({
    name: "workspace.search", aliases: ["search workspace", "find"], capability: "tool:search", effects: [],
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    async execute() { return guarded([secret], { ...defaultGuard("run", "secret"), provenance: ["fixture:vault"], permittedOperations: ["summarize"] }); }
  });
  tools.register({
    name: "message.draft", aliases: ["draft"], capability: "tool:draft", effects: [{ type: "draft", resource: "message", reversible: true }],
    async execute(args) { return guarded({ drafted: true, source: args.body?.value }, mergeGuards(Object.values(args), { name: "draft", trusted: false, guarantees: [] })); }
  });
  return { tools, secret };
}

describe("workflow normalization and analysis", () => {
  it("repairs lenient tool names without broadening capabilities", async () => {
    const { tools } = fixtures();
    const result = await normalizeWorkflow({ steps: [
      { name: "search", tool: "Search_Workspace", args: { query: "project" }, assign: "hits", next: "done" },
      { id: "done", type: "return", result: { hits: { $ref: "hits" } } }
    ] }, { tools, capabilities: ["tool:search"], effects: [] });
    expect(result.graph.nodes.search).toMatchObject({ kind: "tool", tool: "workspace.search" });
    expect(result.decisions).toHaveLength(1);
    const report = analyzeWorkflow(result.graph, { ...grant, capabilities: ["tool:search"] }, tools);
    expect(report.valid).toBe(true);
  });

  it("denies an undeclared tool capability", async () => {
    const { tools } = fixtures();
    const { graph } = await normalizeWorkflow({ steps: [{ id: "draft", tool: "draft", args: {}, next: "done" }, { id: "done", type: "return", result: {} }] }, { tools, capabilities: [], effects: [] });
    const report = analyzeWorkflow(graph, grant, tools);
    expect(report.issues.map(x => x.code)).toContain("UNDECLARED_CAPABILITY");
  });
});

describe("privacy and execution", () => {
  it("chains guarded data but withholds it from the remote receipt", async () => {
    const { tools, secret } = fixtures();
    const { graph, proposalHash, canonicalHash } = await normalizeWorkflow({ entry: "search", steps: [
      { id: "search", tool: "find", arguments: { query: "project" }, assign: "hits", next: "branch" },
      { id: "branch", kind: "condition", condition: { left: { $ref: "hits" }, op: "truthy" }, then: "draft", else: "done" },
      { id: "draft", tool: "draft", arguments: { body: { $ref: "hits" } }, assign: "message", next: "done", retry: { attempts: 2, recover: "done" } },
      { id: "done", type: "return", result: { message: { $ref: "message" } } }
    ] }, { tools, capabilities: grant.capabilities, effects: grant.effects });
    const result = await executeWorkflow(graph, { tools, grant, inputs: {}, instructionHash: proposalHash, canonicalHash });
    expect(result.receipt.status).toBe("completed");
    expect(JSON.stringify(result.localResult)).toContain(secret);
    expect(JSON.stringify(result.receipt)).not.toContain(secret);
    expect(result.receipt.remoteResult).toEqual({ message: { withheld: true, type: "object" } });
    expect(verifyReceipt(result.receipt)).toBe(true);
  });

  it("rejects handles reused across scopes", () => {
    const a = new HandleStore("a"); const b = new HandleStore("b");
    const handle = a.create(guarded("secret", defaultGuard("a", "secret"))).handle!;
    expect(() => b.resolve(handle)).toThrow("HANDLE_SCOPE_VIOLATION");
  });

  it("streams structured logs without private values", async () => {
    const { tools, secret } = fixtures(); const observer = new BufferedObserver(); const lines: string[] = [];
    const capsule: OrchestrationCapsule = { version: "0.1", id: "logged", kind: "orchestration", intent: "safe logs", capabilities: ["tool:search"], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {}, workflow: { steps: [{ id: "s", tool: "find", args: { query: secret }, assign: "found", next: "done" }, { id: "done", type: "return", result: { found: { $ref: "found" } } }] } };
    await run(capsule, { tools, grant, observer: new CompositeObserver([observer, new JsonLogObserver({ write: line => lines.push(line) })]) });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(secret);
    expect(observer.events.some(event => event.durationMs !== undefined)).toBe(true);
  });
});

describe("sandboxed programs", () => {
  it("statically rejects ambient and unbounded APIs", () => {
    const report = analyzeProgram({ language: "lua", source: "while true do os.execute('x') end" }, grant);
    expect(report.valid).toBe(false);
    expect(report.issues.map(x => x.code)).toEqual(expect.arrayContaining(["FORBIDDEN_API", "UNBOUNDED_CONTROL_FLOW"]));
  });

  it("runs a Lua capsule independently from orchestration", async () => {
    const { tools } = fixtures();
    const result = await run({ version: "0.1", id: "code-1", kind: "code", intent: "double locally", capabilities: ["code:execute"], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: { number: guarded(21, { ...defaultGuard("code"), permittedDestinations: ["local", "remote"] }) }, program: { language: "lua", source: "function main(ctx) return ctx.inputs.number * 2 end" } }, { tools, grant });
    expect(result.localResult.result?.value).toBe(42);
    expect(result.receipt.remoteResult).toEqual({ result: 42 });
  });
});

describe("unified orchestration capsule", () => {
  it("normalizes and runs through the public API", async () => {
    const { tools } = fixtures();
    const capsule: OrchestrationCapsule = { version: "0.1", id: "flow-1", kind: "orchestration", intent: "search without disclosure", capabilities: ["tool:search"], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {}, workflow: { steps: [{ id: "s", tool: "find", args: { query: "x" }, assign: "found", next: "end" }, { id: "end", type: "return", result: { found: { $ref: "found" } } }] } };
    const result = await run(capsule, { tools, grant });
    expect(result.receipt.status).toBe("completed");
  });
});
