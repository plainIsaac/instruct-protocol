import { describe, expect, it } from "vitest";
import { BufferedObserver, ToolRegistry, defaultGuard, guarded, run, type Grant, type OrchestrationCapsule } from "../src/index.js";

describe("live performance telemetry", () => {
  it("records streamed events and aggregate execution metrics", async () => {
    const observer = new BufferedObserver();
    const tools = new ToolRegistry().register({
      name: "fixture.echo", capability: "tool:echo", effects: [],
      async execute(args) { return guarded(args.message?.value, defaultGuard("performance")); }
    });
    const grant: Grant = { capabilities: ["tool:echo"], effects: [], disclosureDestinations: ["local"], budget: { maxDurationMs: 1_000, maxInstructions: 10_000, maxMemoryBytes: 4_000_000, maxOutputBytes: 1_000, maxToolCalls: 10, maxCallDepth: 10 } };
    const capsule: OrchestrationCapsule = { version: "0.1", id: "performance", kind: "orchestration", intent: "measure a chain", capabilities: ["tool:echo"], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {}, workflow: { steps: [
      { id: "one", tool: "fixture.echo", args: { message: "a" }, assign: "a", next: "two" },
      { id: "two", tool: "fixture.echo", args: { message: { $ref: "a" } }, assign: "b", next: "done" },
      { id: "done", type: "return", result: { result: { $ref: "b" } } }
    ] } };
    const result = await run(capsule, { tools, grant, observer });
    expect(observer.events[0]?.type).toBe("run.started");
    expect(observer.events.map(event => event.type)).toEqual(expect.arrayContaining(["workflow.normalization.completed", "workflow.analysis.completed", "tool.completed", "workflow.execution.completed"]));
    expect(result.receipt.metrics.toolCalls).toBe(2);
    expect(result.receipt.metrics.nodeCount).toBe(3);
    expect(result.receipt.metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.receipt.events.every((event, index) => event.sequence === index + 1)).toBe(true);
  });
});
