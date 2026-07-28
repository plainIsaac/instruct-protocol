import { ToolRegistry, defaultGuard, guarded, run, type Grant, type OrchestrationCapsule } from "../src/index.js";

const tools = new ToolRegistry().register({
  name: "vault.search", aliases: ["find private notes"], capability: "tool:vault.search", effects: [],
  async execute(args) {
    return guarded([`match for ${String(args.query?.value)}`], {
      ...defaultGuard("demo-run", "confidential"), provenance: ["vault"], permittedOperations: ["summarize"]
    });
  }
});

const grant: Grant = {
  capabilities: ["tool:vault.search", "code:execute"], effects: [], disclosureDestinations: ["local"],
  budget: { maxDurationMs: 1000, maxInstructions: 100_000, maxMemoryBytes: 8_000_000, maxOutputBytes: 10_000, maxToolCalls: 10, maxCallDepth: 10 }
};

const capsule: OrchestrationCapsule = {
  version: "0.1", id: "demo", kind: "orchestration", intent: "Find matching notes and count them locally",
  capabilities: grant.capabilities, effects: [], disclosureBudget: { maxRemoteBytes: 256, allowedLabels: [] }, inputs: {},
  workflow: { entry: "search", steps: [
    { id: "search", tool: "find private notes", args: { query: "launch" }, assign: "matches", next: "count" },
    { id: "count", kind: "code", capabilities: [], inputs: { matches: { $ref: "matches" } }, program: { source: "function main(ctx) return #ctx.inputs.matches end" }, assign: "count", next: "done" },
    { id: "done", type: "return", result: { count: { $ref: "count" } } }
  ] }
};

const result = await run(capsule, { tools, grant });
console.log("local", result.localResult);
console.log("remote-safe", result.receipt.remoteResult);
