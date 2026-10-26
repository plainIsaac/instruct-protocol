import { describe, expect, it } from "vitest";
import { defaultGuard, guarded, HandleStore, run, ToolRegistry, type CodeCapsule, type Grant } from "../src/index.js";

const grant: Grant = {
  capabilities: ["code:execute", "tool:write"], effects: [{ type: "write", reversible: true }], disclosureDestinations: ["local", "remote"],
  budget: { maxDurationMs: 2_000, maxInstructions: 50_000, maxMemoryBytes: 4_000_000, maxOutputBytes: 2_000, maxToolCalls: 4, maxCallDepth: 4 }
};

describe("integrated Lua dependency guards", () => {
  it.each(["empty arguments", "known handle"])("does not bypass all-seen restrictions with %s", async kind => {
    let calls = 0;
    const tools = new ToolRegistry().register({
      name: "writer", capability: "tool:write", effects: grant.effects,
      async execute() { calls++; return guarded("written", defaultGuard("taint")); }
    });
    const secret = guarded("PRIVATE_TAINT_CANARY", { ...defaultGuard("taint", "secret"), permittedOperations: ["tool:read"] });
    const handles = new HandleStore("taint");
    const handle = handles.create(guarded("handle data", { ...defaultGuard("taint", "secret"), permittedOperations: ["tool:write"] }));
    const capsule: CodeCapsule = {
      version: "0.1", id: "taint-check", kind: "code", intent: "verify all-seen guard enforcement", capabilities: grant.capabilities, effects: grant.effects,
      disclosureBudget: { maxRemoteBytes: 500, allowedLabels: [] }, inputs: { secret, handle },
      program: { language: "lua", source: `function main(ctx) return instruct.tool('writer', ${kind === "known handle" ? "{h = ctx.inputs.handle}" : "{}"}) end` }
    };
    const result = await run(capsule, { tools, grant });
    expect(calls).toBe(0);
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.some(event => event.detail.code === "TOOL_OPERATION_DENIED")).toBe(true);
    expect(result.receipt.observedEffects).toEqual([]);
    expect(JSON.stringify(result.receipt)).not.toContain("PRIVATE_TAINT_CANARY");
  });
});
