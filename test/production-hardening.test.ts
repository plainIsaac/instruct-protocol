import { describe, expect, it } from "vitest";
import {
  HandleStore, ToolRegistry, createReceipt, defaultGuard, executeProgram, guarded,
  run, verifyReceipt, type CodeCapsule, type ExecutionMetrics, type Grant,
  type OrchestrationCapsule
} from "../src/index.js";

const budget = {
  maxDurationMs: 100, maxInstructions: 100, maxMemoryBytes: 1_000_000,
  maxOutputBytes: 1_000, maxToolCalls: 10, maxCallDepth: 10
};
const grant: Grant = {
  capabilities: ["code:execute", "tool:test"], effects: [],
  disclosureDestinations: ["local", "remote"], budget
};
const metrics: ExecutionMetrics = {
  totalDurationMs: 0, normalizationDurationMs: 0, analysisDurationMs: 0,
  executionDurationMs: 0, receiptDurationMs: 0, nodeCount: 0, toolCalls: 0,
  codeExecutions: 0, retries: 0, recoveries: 0, failures: 0, peakCallDepth: 0
};

function codeCapsule(): CodeCapsule {
  return {
    version: "0.1", id: "code", kind: "code", intent: "bounded code",
    capabilities: ["code:execute"], effects: [],
    disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {},
    program: { language: "lua", source: "function main(ctx) return 1 end" }
  };
}

describe("production authority and budget boundaries", () => {
  it("requires code capsules to declare code execution authority", async () => {
    const capsule = codeCapsule(); capsule.capabilities = [];
    const result = await run(capsule, { tools: new ToolRegistry(), grant });
    expect(result.receipt.status).toBe("denied");
    expect(result.receipt.events.find(event => event.type === "run.denied")?.detail.code).toBe("CAPSULE_CODE_CAPABILITY_UNDECLARED");
  });

  it("does not allow a child program to expand its parent output budget", async () => {
    await expect(executeProgram({
      language: "lua", source: "function main(ctx) return 'expanded' end",
      budget: { maxOutputBytes: 10_000 }
    // Isolate output enforcement from VM startup time and instruction metering.
    }, { inputs: {}, grant: { ...grant, budget: { ...budget, maxDurationMs: 2_000, maxInstructions: 10_000, maxOutputBytes: 2 } } }))
      .rejects.toThrow("OUTPUT_BUDGET_EXCEEDED");
  });

  it("terminates cyclic workflows at the instruction budget", async () => {
    const capsule: OrchestrationCapsule = {
      version: "0.1", id: "cycle", kind: "orchestration", intent: "cycle",
      capabilities: [], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {},
      workflow: { steps: [{ id: "again", kind: "join", next: "again" }] }
    };
    const result = await run(capsule, { tools: new ToolRegistry(), grant: { ...grant, budget: { ...budget, maxInstructions: 3 } } });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.some(event => event.detail.code === "WORKFLOW_INSTRUCTION_BUDGET_EXCEEDED")).toBe(true);
  });

  it("times out a tool that ignores cooperative cancellation", async () => {
    const tools = new ToolRegistry().register({
      name: "test.hang", capability: "tool:test", effects: [],
      execute: async () => new Promise(() => {})
    });
    const capsule: OrchestrationCapsule = {
      version: "0.1", id: "timeout", kind: "orchestration", intent: "timeout",
      capabilities: ["tool:test"], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {},
      workflow: { steps: [{ id: "hang", tool: "test.hang" }] }
    };
    const result = await run(capsule, { tools, grant: { ...grant, budget: { ...budget, maxDurationMs: 10 } } });
    expect(result.receipt.status).toBe("failed");
  });
});

describe("production data boundaries", () => {
  it("enforces stored handle expiry and single-use replay protection", () => {
    const expiredStore = new HandleStore("scope");
    const expired = expiredStore.create(guarded("secret", { ...defaultGuard("scope"), expiresAt: new Date(0).toISOString(), correlation: "session" })).handle!;
    expect(() => expiredStore.resolve({ ...expired, expiresAt: undefined })).toThrow("HANDLE_EXPIRED");

    const oneUseStore = new HandleStore("scope");
    const single = oneUseStore.create(guarded("secret", defaultGuard("scope"))).handle!;
    expect(oneUseStore.resolve(single).value).toBe("secret");
    expect(() => oneUseStore.resolve(single)).toThrow("HANDLE_NOT_FOUND");
  });

  it("fails closed when a tool returns an unguarded value", async () => {
    const tools = new ToolRegistry().register({
      name: "test.invalid", capability: "tool:test", effects: [],
      execute: async () => ({ secret: "unguarded" }) as never
    });
    const capsule: OrchestrationCapsule = {
      version: "0.1", id: "invalid-output", kind: "orchestration", intent: "invalid output",
      capabilities: ["tool:test"], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {},
      workflow: { steps: [{ id: "call", tool: "test.invalid", next: "done" }, { id: "done", type: "return", result: {} }] }
    };
    const result = await run(capsule, { tools, grant });
    expect(result.receipt.status).toBe("failed");
    expect(JSON.stringify(result.receipt)).not.toContain("unguarded");
  });

  it("returns false instead of throwing for malformed receipts", () => {
    const receipt = createReceipt({ instructionHash: "a".repeat(64), status: "completed", events: [], metrics, remoteResult: {}, observedEffects: [] });
    expect(verifyReceipt(receipt)).toBe(true);
    expect(verifyReceipt({ ...receipt, receiptHash: "not-a-digest" })).toBe(false);
    expect(verifyReceipt({ ...receipt, remoteResult: new Map() })).toBe(false);
  });
});
