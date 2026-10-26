import { describe, expect, it } from "vitest";
import { assertDestination, defaultGuard, guarded, mergeGuards } from "../src/guarded.js";
import { invokeTool, ToolRegistry, type ToolDefinition } from "../src/tools.js";
import { processTool } from "../src/process-tool.js";
import { run } from "../src/run.js";
import type { Grant, OrchestrationCapsule } from "../src/types.js";
import type { Guard, GuardedValue } from "../src/types.js";

const context = { simulate: false, variables: {} };
const input = (guard: Partial<Guard> = {}) => guarded("private", { ...defaultGuard("test", "confidential"), permittedOperations: ["tool:inspect"], ...guard });
function fixture(overrides: Partial<ToolDefinition> = {}) {
  let calls = 0;
  const tool: ToolDefinition = { name: "inspect", capability: "tool:inspect", effects: [], async execute() { calls++; return guarded("ok", defaultGuard("test")); }, ...overrides };
  return { tool, calls: () => calls, invoke: (value: GuardedValue) => invokeTool(tool, { value }, context, performance.now() + 1_000) };
}

describe("Toolring and Lua code-node guard parity", () => {
  const capabilities = ["code:execute", "tool:inspect"];
  const grant: Grant = { capabilities, effects: [], disclosureDestinations: ["local", "remote"], budget: { maxDurationMs: 2_000, maxInstructions: 100_000, maxMemoryBytes: 8_000_000, maxOutputBytes: 2_000, maxToolCalls: 4, maxCallDepth: 8 } };
  const capsule = (lua: boolean, value: GuardedValue): OrchestrationCapsule => ({
    version: "0.1", id: "guard-parity", kind: "orchestration", intent: "check guard enforcement", capabilities, effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: { value },
    workflow: { steps: [
      lua ? { id: "call", kind: "code", capabilities, inputs: { value: { $ref: "value" } }, program: { language: "lua", source: "function main(ctx) return instruct.tool('inspect', { value = ctx.inputs.value }) end" }, assign: "out", next: "done" }
        : { id: "call", tool: "inspect", args: { value: { $ref: "value" } }, assign: "out", next: "done" },
      { id: "done", type: "return", result: { out: { $ref: "out" } } }
    ] }
  });

  it.each([
    [{ permittedOperations: [] }, "TOOL_OPERATION_DENIED"],
    [{ permittedDestinations: ["tool:other"] }, "TOOL_DESTINATION_DENIED"],
    [{ expiresAt: "2000-01-01T00:00:00Z" }, "TOOL_INPUT_EXPIRED"]
  ] as const)("denies %j without actual tool execution in either path", async (restrictions, code) => {
    for (const lua of [false, true]) {
      const f = fixture(); const tools = new ToolRegistry().register(f.tool);
      const result = await run(capsule(lua, input(restrictions as Partial<Guard>)), { tools, grant });
      expect(result.receipt.status).toBe("failed"); expect(f.calls()).toBe(0);
      expect(result.receipt.events).toContainEqual(expect.objectContaining({ type: lua ? "program.tool.failed" : "node.failed", detail: expect.objectContaining({ code }) }));
    }
  });

  it("accepts exact operation/destination permissions in both paths and preserves sensitivity", async () => {
    for (const lua of [false, true]) {
      const f = fixture(); const result = await run(capsule(lua, input({ permittedDestinations: ["tool:inspect"] })), { tools: new ToolRegistry().register(f.tool), grant });
      expect(result.receipt.status).toBe("completed"); expect(f.calls()).toBe(1);
      expect(result.localResult.out?.value).toBe("ok"); expect(result.localResult.out?.guard.sensitivity).toBe("confidential");
    }
  });

  it("rejects invalid tool outputs in both paths", async () => {
    for (const lua of [false, true]) {
      const f = fixture({ async execute() { return { kind: "guarded", value: "bad", guard: {} } as GuardedValue; } });
      const result = await run(capsule(lua, input()), { tools: new ToolRegistry().register(f.tool), grant });
      expect(result.receipt.status).toBe("failed");
      expect(result.receipt.events).toContainEqual(expect.objectContaining({ type: lua ? "program.tool.failed" : "node.failed", detail: expect.objectContaining({ code: "TOOL_OUTPUT_INVALID" }) }));
    }
  });
});

describe("process tool guard metadata", () => {
  it("forwards operation and trusted-transform declarations and runs the real process", async () => {
    const output = guarded("fixed-status", { ...defaultGuard("test"), permittedDestinations: ["local", "remote"] });
    const outputTransform = { name: "fixed-status", guarantees: ["Returns only a fixed status"] };
    const tool = processTool({ name: "child", capability: "tool:child", operations: ["read"], outputTransform, effects: [], command: process.execPath, args: ["-e", `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(${JSON.stringify(JSON.stringify(output))}));`] });
    expect(tool.operations).toEqual(["read"]); expect(tool.outputTransform).toEqual(outputTransform);
    const result = await invokeTool(tool, { value: input({ permittedOperations: ["read"] }) }, context, performance.now() + 2_000);
    expect(result.value).toBe("fixed-status"); expect(result.guard.sensitivity).toBe("public");
    expect(result.guard.transformations.at(-1)).toMatchObject({ name: "fixed-status", trusted: true });
  });
});

describe("guard intersections", () => {
  it("uses local/tool wildcard semantics for destination assertions without permitting remote or other tools", () => {
    expect(() => assertDestination(input({ permittedDestinations: ["local"] }), "tool:inspect")).not.toThrow();
    expect(() => assertDestination(input({ permittedDestinations: ["tool:*"] }), "tool:inspect")).not.toThrow();
    expect(() => assertDestination(input({ permittedDestinations: ["tool:other"] }), "tool:inspect")).toThrow("DESTINATION_DENIED");
    expect(() => assertDestination(input({ permittedDestinations: ["local"] }), "remote")).toThrow("DESTINATION_DENIED");
  });
  it.each([
    [["*"], ["read"], ["read"]],
    [["read"], ["*"], ["read"]],
    [["*"], [], []],
    [[], ["*"], []],
    [["read"], ["write"], []],
    [["*"], ["*"], ["*"]]
  ])("intersects operations %j and %j as %j", (left, right, expected) => {
    const merged = mergeGuards([input({ permittedOperations: left }), input({ permittedOperations: right })]);
    expect(merged.permittedOperations).toEqual(expected);
  });

  it.each([
    [["local"], ["tool:inspect"], ["tool:inspect"]],
    [["tool:inspect"], ["local"], ["tool:inspect"]],
    [["tool:*"], ["tool:inspect"], ["tool:inspect"]],
    [["tool:inspect"], ["tool:*"], ["tool:inspect"]],
    [["local"], ["remote"], []],
    [["local"], [], []]
  ] as const)("intersects destinations %j and %j as %j", (left, right, expected) => {
    const merged = mergeGuards([input({ permittedDestinations: [...left] }), input({ permittedDestinations: [...right] })]);
    expect(merged.permittedDestinations).toEqual(expected);
  });

  it("does not turn a disjoint merge into unrestricted tool permission", async () => {
    const f = fixture();
    const guard = mergeGuards([input({ permittedOperations: ["read"] }), input({ permittedOperations: ["write"] })]);
    await expect(f.invoke(guarded("combined", guard))).rejects.toThrow("TOOL_OPERATION_DENIED");
    expect(f.calls()).toBe(0);
  });
});

describe("tool value guards", () => {
  it("uses every explicit tool operation rather than its capability", async () => {
    const f = fixture({ operations: ["read", "inspect"] });
    await expect(f.invoke(input({ permittedOperations: ["read", "inspect"] }))).resolves.toMatchObject({ value: "ok" });
    await expect(f.invoke(input({ permittedOperations: ["read"] }))).rejects.toThrow("TOOL_OPERATION_DENIED");
    expect(f.calls()).toBe(1);
  });

  it("grants literal/default values explicit wildcard operations without granting remote disclosure", async () => {
    expect(defaultGuard("literal").permittedOperations).toEqual(["*"]);
    expect(defaultGuard("literal").permittedDestinations).toEqual(["local"]);
    await expect(fixture().invoke(guarded(1, defaultGuard("literal")))).resolves.toMatchObject({ value: "ok" });
  });

  it.each([
    ["empty operations", { permittedOperations: [] }, "TOOL_OPERATION_DENIED"],
    ["empty destinations", { permittedDestinations: [] }, "TOOL_DESTINATION_DENIED"],
    ["another tool", { permittedDestinations: ["tool:other"] }, "TOOL_DESTINATION_DENIED"],
    ["remote only", { permittedDestinations: ["remote"] }, "TOOL_DESTINATION_DENIED"],
    ["expired", { expiresAt: "2000-01-01T00:00:00Z" }, "TOOL_INPUT_EXPIRED"],
    ["invalid expiry", { expiresAt: "never" }, "TOOL_INPUT_INVALID"],
    ["invalid operations", { permittedOperations: null }, "TOOL_INPUT_INVALID"]
  ] as const)("rejects %s before execution or the invocation callback", async (_name, restrictions, code) => {
    const f = fixture(); let invoked = false;
    await expect(invokeTool(f.tool, { value: input(restrictions as unknown as Partial<Guard>) }, context, performance.now() + 1_000, () => { invoked = true; })).rejects.toThrow(code);
    expect(f.calls()).toBe(0); expect(invoked).toBe(false);
  });

  it.each(["local", "tool:inspect", "tool:*"] as const)("accepts destination %s", async destination => {
    await expect(fixture().invoke(input({ permittedDestinations: [destination], expiresAt: "2099-01-01T00:00:00Z" }))).resolves.toMatchObject({ value: "ok" });
  });

  it("rejects a handle whose own expiry has elapsed", async () => {
    const f = fixture();
    await expect(f.invoke({ ...input(), handle: { id: "h", type: "doc", scope: "test", expiresAt: "2000-01-01T00:00:00Z" } })).rejects.toThrow("TOOL_INPUT_EXPIRED");
    expect(f.calls()).toBe(0);
  });

  it("preserves contributing restrictions even when an output claims to be public or trusted", async () => {
    const provenance = ["source:private"];
    const source = input({ provenance, sourceHandles: ["h_source"], permittedDestinations: ["tool:inspect"], expiresAt: "2098-01-01T00:00:00Z" });
    const f = fixture({ async execute() { return guarded("formatted", {
      ...defaultGuard("test"), permittedDestinations: ["local", "remote"],
      transformations: [{ name: "self-approved", trusted: true, guarantees: ["public"], inputProvenance: [], at: "2026-01-01T00:00:00Z" }]
    }); } });
    const result = await f.invoke(source);
    expect(result.guard).toMatchObject({ sensitivity: "confidential", provenance, sourceHandles: ["h_source"], permittedOperations: ["tool:inspect"], permittedDestinations: ["tool:inspect"], expiresAt: source.guard.expiresAt });
  });

  it("allows only a host-declared trusted output transform to replace restrictions and records its guarantee", async () => {
    const source = input({ provenance: ["private-source"], expiresAt: "2098-01-01T00:00:00Z" });
    const f = fixture({
      outputTransform: { name: "status-only", guarantees: ["Only a fixed public operation status is returned"] },
      async execute() { return guarded("ok", { ...defaultGuard("test"), permittedDestinations: ["local", "remote"] }); }
    });
    const result = await f.invoke(source);
    expect(result.guard).toMatchObject({ sensitivity: "public", permittedDestinations: ["local", "remote"], provenance: ["private-source"], expiresAt: source.guard.expiresAt });
    expect(result.guard.transformations).toContainEqual(expect.objectContaining({ name: "status-only", trusted: true, guarantees: ["Only a fixed public operation status is returned"], inputProvenance: ["private-source"] }));
  });

  it.each([{ operations: [] }, { operations: [""] }, { operations: ["read", "read"] }])("rejects invalid explicit operation declarations $operations", ({ operations }) => {
    expect(() => new ToolRegistry().register(fixture({ operations }).tool)).toThrow("INVALID_TOOL_DEFINITION");
  });

  it("does not bypass operations when invokeTool receives an empty explicit declaration", async () => {
    const f = fixture({ operations: [] });
    await expect(f.invoke(input())).rejects.toThrow("INVALID_TOOL_DEFINITION");
    expect(f.calls()).toBe(0);
  });

  it.each([{}, { name: "", guarantees: ["status"] }, { name: "status", guarantees: [] }])("rejects invalid trusted output metadata %j", outputTransform => {
    expect(() => new ToolRegistry().register(fixture({ outputTransform: outputTransform as ToolDefinition["outputTransform"] }).tool)).toThrow("INVALID_TOOL_DEFINITION");
  });

  it.each([
    [false, "cancel"], [false, "deadline"], [true, "cancel"], [true, "deadline"]
  ] as const)("does not start execute/simulate (simulate=%s, reason=%s)", async (simulate, reason) => {
    let invoked = false; let executed = false;
    const f = fixture({ async execute() { executed = true; return input(); }, async simulate() { executed = true; return input(); } });
    const controller = new AbortController();
    if (reason === "cancel") controller.abort();
    await expect(invokeTool(f.tool, { value: input() }, { ...context, simulate, signal: controller.signal }, performance.now() + (reason === "deadline" ? -1 : 1_000), () => { invoked = true; })).rejects.toThrow(reason === "cancel" ? "EXECUTION_ABORTED" : "WORKFLOW_TIMEOUT");
    expect(executed).toBe(false); expect(invoked).toBe(false);
  });

  it.each([
    { value: { kind: "guarded", value: "bad", guard: {} }, code: "TOOL_OUTPUT_INVALID" },
    { value: guarded("bad", { ...defaultGuard("test"), expiresAt: "nonsense" }), code: "TOOL_OUTPUT_INVALID" },
    { value: guarded("bad", { ...defaultGuard("test"), expiresAt: "2000-01-01T00:00:00Z" }), code: "TOOL_OUTPUT_EXPIRED" },
    { value: { ...input(), handle: { id: "h", type: "doc", scope: "test", expiresAt: "2000-01-01T00:00:00Z" } }, code: "TOOL_OUTPUT_EXPIRED" }
  ])("rejects invalid/unusable guarded outputs ($code)", async ({ value, code }) => {
    const f = fixture({ async execute() { return value as GuardedValue; } });
    await expect(f.invoke(input())).rejects.toThrow(code);
  });

  it("propagates the earliest contributing handle expiry into a derived guard", async () => {
    const source = { ...input(), handle: { id: "h", type: "doc", scope: "test", expiresAt: "2098-01-01T00:00:00Z" } };
    expect((await fixture().invoke(source)).guard.expiresAt).toBe(source.handle.expiresAt);
  });

  it("leaves sensitive default guards deny-by-default for tool operations", () => {
    for (const sensitivity of ["internal", "confidential", "secret"] as const) expect(defaultGuard("sensitive", sensitivity).permittedOperations).toEqual([]);
  });

  it("copies host authorization metadata at registration", () => {
    const operations = ["read"]; const outputTransform = { name: "fixed", guarantees: ["fixed public status"] };
    const tools = new ToolRegistry().register(fixture({ operations, outputTransform }).tool);
    operations.push("write"); outputTransform.guarantees.push("changed"); outputTransform.name = "changed";
    expect(tools.get("inspect")?.operations).toEqual(["read"]);
    expect(tools.get("inspect")?.outputTransform).toEqual({ name: "fixed", guarantees: ["fixed public status"] });
  });

  it("enforces additional host contributors even when a Lua-style call has no arguments", async () => {
    const f = fixture();
    await expect(invokeTool(f.tool, {}, { ...context, guardContributors: [input({ permittedOperations: [] })] }, performance.now() + 1_000)).rejects.toThrow("TOOL_OPERATION_DENIED");
    expect(f.calls()).toBe(0);
    const output = await invokeTool(f.tool, {}, { ...context, guardContributors: [input()] }, performance.now() + 1_000);
    expect(output.guard.sensitivity).toBe("confidential");
  });

  it("denies an operation not permitted by an input before invoking the tool", async () => {
    const f = fixture();
    await expect(f.invoke(input({ permittedOperations: ["other"] }))).rejects.toThrow("TOOL_OPERATION_DENIED");
    expect(f.calls()).toBe(0);
  });
});
