import { describe, expect, it } from "vitest";
import {
  HandleStore, ToolRegistry, defaultGuard, executeProgram, guarded, run,
  type CodeCapsule, type Grant, type OrchestrationCapsule
} from "../src/index.js";

const budget = { maxDurationMs: 1_000, maxInstructions: 100_000, maxMemoryBytes: 4_000_000, maxOutputBytes: 1_000, maxToolCalls: 4, maxCallDepth: 4 };
const grant: Grant = { capabilities: ["code:execute", "tool:vault", "tool:write"], effects: [{ type: "write", resource: "fixture", reversible: true }], disclosureDestinations: ["local", "remote"], budget };
const SECRET = "hunter2-swordfish";

function code(source: string, overrides: Partial<CodeCapsule> = {}): CodeCapsule {
  return {
    version: "0.1", id: "sandbox", kind: "code", intent: "sandbox boundary", capabilities: ["code:execute"], effects: [],
    disclosureBudget: { maxRemoteBytes: 200, allowedLabels: [] }, inputs: {}, program: { language: "lua", source }, ...overrides
  };
}
function failureCode(result: Awaited<ReturnType<typeof run>>): unknown {
  return result.receipt.events.find(event => event.type === "program.failed")?.detail.code;
}
function vaultTools() {
  return new ToolRegistry()
    .register({ name: "vault", capability: "tool:vault", effects: [], async execute() { return guarded(SECRET, defaultGuard("vault", "secret")); } })
    .register({ name: "write", capability: "tool:write", effects: grant.effects, async execute() { return guarded("ok", { ...defaultGuard("write"), permittedDestinations: ["local", "remote"] }); } });
}

describe("Lua resource limits", () => {
  it("stops unbounded recursion at the instruction budget", async () => {
    const result = await run(code("local function f(n) return f(n + 1) end function main(ctx) return f(0) end"), { tools: new ToolRegistry(), grant });
    expect(result.receipt.status).toBe("failed");
    expect(failureCode(result)).toBe("INSTRUCTION_BUDGET_EXCEEDED");
  });

  it("does not let pcall absorb budget exhaustion", async () => {
    const source = "local function spin() local x = 0 for i = 1, 100000 do x = x + 1 end end local function again() pcall(spin) return again() end function main(ctx) return again() end";
    const result = await run(code(source), { tools: new ToolRegistry(), grant });
    expect(failureCode(result)).toBe("INSTRUCTION_BUDGET_EXCEEDED");
  });

  it("terminates runaway library calls that no Lua hook can interrupt", async () => {
    const started = performance.now();
    const source = "function main(ctx) return string.find(string.rep('a', 5000), '.-.-.-.-.-.-.-.-b') end";
    const result = await run(code(source), { tools: new ToolRegistry(), grant: { ...grant, budget: { ...budget, maxDurationMs: 200 } } });
    expect(failureCode(result)).toBe("PROGRAM_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("enforces the memory budget", async () => {
    const source = "function main(ctx) local t = {} for i = 1, 10000 do for j = 1, 1000 do t[#t + 1] = j end end return #t end";
    const result = await run(code(source), { tools: new ToolRegistry(), grant: { ...grant, budget: { ...budget, maxInstructions: 1e9 } } });
    expect(failureCode(result)).toBe("MEMORY_BUDGET_EXCEEDED");
  });

  it("cancels a running program when the signal aborts", async () => {
    const run = executeProgram({ language: "lua", source: "local function f(n) return f(n + 1) end function main(ctx) return f(0) end" },
      { inputs: {}, grant: { ...grant, budget: { ...budget, maxInstructions: 1e12, maxDurationMs: 10_000 } }, signal: AbortSignal.timeout(30) });
    await expect(run).rejects.toThrow("EXECUTION_ABORTED");
  });

  it("gives a workflow code node only the parent's remaining time", async () => {
    const tools = new ToolRegistry().register({ name: "slow", capability: "tool:vault", effects: [], async execute() { await new Promise(r => setTimeout(r, 600)); return guarded(1, defaultGuard("slow")); } });
    const capsule: OrchestrationCapsule = {
      version: "0.1", id: "remaining", kind: "orchestration", intent: "remaining budget", capabilities: ["code:execute", "tool:vault"], effects: [],
      disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {},
      workflow: { steps: [
        { id: "a", tool: "slow", next: "b" },
        { id: "b", kind: "code", program: "local function f(n) return f(n + 1) end function main(ctx) return f(0) end", next: "c" },
        { id: "c", type: "return", result: {} }
      ] }
    };
    const started = performance.now();
    const result = await run(capsule, { tools, grant: { ...grant, budget: { ...budget, maxDurationMs: 900, maxInstructions: 1e12 } } });
    expect(result.receipt.status).toBe("failed");
    // With the full budget again the program alone would run 900 ms, for about 1.5 s in total.
    expect(performance.now() - started).toBeLessThan(1_300);
  });
});

describe("Lua ambient authority and disclosure surfaces", () => {
  it("refuses __gc finalizers, which run with hooks disabled", async () => {
    const source = "function main(ctx) setmetatable({}, { __gc = function() end }) return 1 end";
    const result = await run(code(source), { tools: new ToolRegistry(), grant });
    expect(failureCode(result)).toBe("GC_METAMETHOD_DENIED");
  });

  it("copies host values into plain tables with no JavaScript surface", async () => {
    const capsule = code("function main(ctx) return { type(ctx.inputs.o), type(ctx.inputs.o.constructor), type(ctx.inputs.o.__proto__), type(ctx.inputs.o.x) } end", {
      inputs: { o: guarded({ x: 1 }, { ...defaultGuard("s"), permittedDestinations: ["local", "remote"] }) }
    });
    const result = await run(capsule, { tools: new ToolRegistry(), grant });
    expect(result.localResult.result?.value).toEqual(["table", "nil", "nil", "number"]);
  });

  it("keeps data-dependent execution metadata out of events", async () => {
    const details = await Promise.all(["a", "abcdefghij"].map(async secret => {
      const capsule = code("function main(ctx) local s = '' for i = 1, #ctx.inputs.s * 100 do s = s .. 'x' end return s end", { inputs: { s: guarded(secret, defaultGuard("s", "secret")) } });
      const result = await run(capsule, { tools: new ToolRegistry(), grant: { ...grant, budget: { ...budget, maxOutputBytes: 10_000 } } });
      return result.receipt.events.find(event => event.type === "program.completed")?.detail;
    }));
    expect(details[0]).toEqual({ toolCalls: 0 });
    expect(details[1]).toEqual(details[0]);
  });

  it("denies a program that requests an invalid budget", async () => {
    const capsule = code("function main(ctx) return 1 end");
    capsule.program.budget = { maxInstructions: -1 };
    const result = await executeProgram(capsule.program, { inputs: {}, grant }).catch((error: Error) => error.message);
    expect(result).toBe("PROGRAM_DENIED:INVALID_PROGRAM_BUDGET");
  });

  it("removes ambient, clock, randomness, debug, and coroutine facilities", async () => {
    const names = ["io", "os", "debug", "coroutine", "print", "require", "load", "dofile", "loadfile", "collectgarbage", "__tool", "__inputs"];
    // Names are reversed so the advisory static check does not reject the probe itself.
    const lookups = names.map(n => `type(_G[string.reverse('${[...n].reverse().join("")}')])`).join(", ");
    const source = `function main(ctx) local d = ('x')['du' .. 'mp'] return { ${lookups}, type(math.random), type(math.randomseed), type(d) } end`;
    const value = await executeProgram({ language: "lua", source }, { inputs: {}, grant });
    expect(value.value).toEqual(Array(names.length + 3).fill("nil"));
  });

  it("never copies Lua error text into events or receipts", async () => {
    for (const message of [SECRET, "TOOL_HUNTER2_SWORDFISH"]) {
      const capsule = code(`function main(ctx) error(ctx.inputs.s .. '${message}', 0) end`, { inputs: { s: guarded("x", defaultGuard("s", "secret")) } });
      const result = await run(capsule, { tools: new ToolRegistry(), grant });
      expect(failureCode(result)).toBe("LUA_RUNTIME_ERROR");
      expect(JSON.stringify(result.receipt)).not.toMatch(/HUNTER2|hunter2/);
    }
  });

  it("never copies tool error text into events or receipts", async () => {
    const tools = new ToolRegistry().register({ name: "leaky", capability: "tool:vault", effects: [], async execute() { throw new Error(`password is ${SECRET}`); } });
    const capsule: OrchestrationCapsule = {
      version: "0.1", id: "leaky", kind: "orchestration", intent: "tool error", capabilities: ["tool:vault"], effects: [],
      disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {}, workflow: { steps: [{ id: "a", tool: "leaky" }] }
    };
    const result = await run(capsule, { tools, grant });
    expect(result.receipt.events.find(event => event.type === "node.failed")?.detail.code).toBe("TOOL_FAILED");
    expect(JSON.stringify(result.receipt).toLowerCase()).not.toContain("swordfish");
  });
});

describe("Lua tool API", () => {
  it("propagates tool-result guards to the program result", async () => {
    const capsule = code("function main(ctx) return 'got ' .. instruct.tool('vault', {}) end", { capabilities: ["code:execute", "tool:vault"] });
    const result = await run(capsule, { tools: vaultTools(), grant });
    expect(result.receipt.status).toBe("completed");
    expect(result.localResult.result?.value).toBe(`got ${SECRET}`);
    expect(result.localResult.result?.guard.sensitivity).toBe("secret");
    expect(JSON.stringify(result.receipt)).not.toContain(SECRET);
  });

  it("records effects of tools invoked from Lua", async () => {
    const capsule = code("function main(ctx) return instruct.tool('write', {}) end", { capabilities: ["code:execute", "tool:write"], effects: grant.effects });
    const result = await run(capsule, { tools: vaultTools(), grant });
    expect(result.receipt.status).toBe("completed");
    expect(result.receipt.observedEffects).toEqual(grant.effects);
  });

  it("denies at runtime a tool the capsule did not declare, even when granted", async () => {
    const capsule = code("function main(ctx) local name = 'va' .. 'ult' return instruct.tool(name, {}) end");
    const result = await run(capsule, { tools: vaultTools(), grant });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.events.find(event => event.type === "program.tool.failed")?.detail.code).toBe("TOOL_CAPABILITY_DENIED");
  });

  it("denies a tool whose effect was not declared", async () => {
    const capsule = code("function main(ctx) return instruct.tool('write', {}) end", { capabilities: ["code:execute", "tool:write"] });
    const result = await run(capsule, { tools: vaultTools(), grant });
    expect(result.receipt.events.find(event => event.type === "program.tool.failed")?.detail.code).toBe("TOOL_EFFECT_DENIED");
    expect(result.receipt.observedEffects).toEqual([]);
  });

  it("passes known handles back to tools and rejects forged ones", async () => {
    const store = new HandleStore("scope");
    const tools = new ToolRegistry()
      .register({ name: "open", capability: "tool:vault", effects: [], async execute() { return store.create(guarded(SECRET, defaultGuard("scope", "secret")), "doc"); } })
      .register({ name: "measure", capability: "tool:vault", effects: [], async execute(args) { return guarded(String(store.resolve(args.doc!.handle!).value).length, defaultGuard("scope")); } });
    const ok = await run(code("function main(ctx) local h = instruct.tool('open', {}) return instruct.tool('measure', { doc = h }) end", { capabilities: ["code:execute", "tool:vault"] }), { tools, grant });
    expect(ok.localResult.result?.value).toBe(SECRET.length);
    const forged = await run(code("function main(ctx) return instruct.tool('measure', { doc = { ['$handle'] = 'h_forged', type = 'doc' } }) end", { capabilities: ["code:execute", "tool:vault"] }), { tools, grant });
    expect(forged.receipt.events.find(event => event.type === "program.tool.failed")?.detail.code).toBe("TOOL_UNKNOWN_HANDLE");
  });
});
