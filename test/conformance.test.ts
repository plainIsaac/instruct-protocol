import { describe, expect, it } from "vitest";
import {
  ToolRegistry, canonicalJson, createReceipt, defaultGuard, guarded,
  referenceDigest, run, validateInstructionCapsule, verifyReceipt,
  type CodeCapsule, type ExecutionMetrics, type Grant
} from "../src/index.js";

const budget = {
  maxDurationMs: 1_000, maxInstructions: 10_000, maxMemoryBytes: 1_000_000,
  maxOutputBytes: 1_000, maxToolCalls: 2, maxCallDepth: 2
};
const grant: Grant = {
  capabilities: ["code:execute"], effects: [], disclosureDestinations: ["local", "remote"], budget
};
const metrics: ExecutionMetrics = {
  totalDurationMs: 1, normalizationDurationMs: 0, analysisDurationMs: 0,
  executionDurationMs: 1, receiptDurationMs: 0, nodeCount: 0, toolCalls: 0,
  codeExecutions: 1, retries: 0, recoveries: 0, failures: 0, peakCallDepth: 1
};

function capsule(): CodeCapsule {
  return {
    version: "0.1", id: "conformance", kind: "code", intent: "return a local value",
    capabilities: ["code:execute"], effects: [],
    disclosureBudget: { maxRemoteBytes: 64, allowedLabels: [] },
    inputs: { value: guarded(3, { ...defaultGuard("test"), permittedDestinations: ["local", "remote"] }) },
    program: { language: "lua", source: "function main(ctx) return ctx.inputs.value end" }
  };
}

describe("reference implementation digest encoding", () => {
  it("produces the same digest regardless of object insertion order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(referenceDigest({ b: 2, a: 1 })).toBe(referenceDigest({ a: 1, b: 2 }));
    expect(canonicalJson({ "\uE000": 1, "\u{10000}": 2 }))
      .toBe('{"\uE000":1,"𐀀":2}');
  });

  it("fails closed for values JSON would silently alter", () => {
    expect(canonicalJson({ present: true, missing: undefined })).toBe('{"present":true}');
    expect(() => canonicalJson([undefined])).toThrow("CANONICAL_UNSUPPORTED_VALUE");
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow("CANONICAL_NON_FINITE_NUMBER");
    expect(() => canonicalJson(new Date(0))).toThrow("CANONICAL_UNSUPPORTED_OBJECT");
    expect(() => canonicalJson(new Map())).toThrow("CANONICAL_UNSUPPORTED_OBJECT");
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("CANONICAL_CYCLE");
  });

  it("detects receipt tampering independent of key order", () => {
    const receipt = createReceipt({
      instructionHash: "a".repeat(64), status: "completed", events: [], metrics,
      remoteResult: { b: 2, a: 1 }, observedEffects: []
    });
    expect(verifyReceipt(receipt)).toBe(true);
    receipt.remoteResult = { a: 1, b: 3 };
    expect(verifyReceipt(receipt)).toBe(false);
  });
});

describe("capsule boundary validation", () => {
  it("accepts a complete capsule and executes it", async () => {
    expect(validateInstructionCapsule(capsule())).toEqual([]);
    const result = await run(capsule(), { tools: new ToolRegistry(), grant });
    expect(result.receipt.status).toBe("completed");
  });

  it("rejects malformed guards and mixed instruction kinds before execution", async () => {
    const malformed = capsule() as unknown as Record<string, any>;
    malformed.workflow = { steps: [] };
    malformed.inputs.value.guard.scope = "";
    malformed.inputs.value.guard.permittedDestinations = "remote";
    const errors = validateInstructionCapsule(malformed);
    expect(errors).toEqual(expect.arrayContaining([
      "$.workflow: not allowed for code",
      "$.inputs.value.guard.scope: expected non-empty string",
      "$.inputs.value.guard.permittedDestinations: expected array"
    ]));
    await expect(run(malformed as CodeCapsule, { tools: new ToolRegistry(), grant }))
      .rejects.toThrow("INVALID_CAPSULE");
  });

  it("rejects duplicate authority declarations and invalid disclosure limits", () => {
    const malformed = capsule();
    malformed.capabilities.push("code:execute");
    malformed.disclosureBudget.maxRemoteBytes = -1;
    expect(validateInstructionCapsule(malformed)).toEqual(expect.arrayContaining([
      "$.capabilities: duplicate values",
      "$.disclosureBudget.maxRemoteBytes: expected non-negative integer"
    ]));
  });

  it("rejects an invalid value before notifying observers", async () => {
    let observed = false;
    const observer = { onEvent() { observed = true; } };
    await expect(run(null as unknown as CodeCapsule, { tools: new ToolRegistry(), grant, observer }))
      .rejects.toThrow("INVALID_CAPSULE");
    expect(observed).toBe(false);
  });
});
