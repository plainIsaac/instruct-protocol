import { describe, expect, it } from "vitest";
import {
  ConfidentialRetrievalService, HashingEmbedder, LocalIntentInterpreter,
  defaultGuard, guarded, run, type Grant, type OrchestrationCapsule
} from "../src/index.js";

const secrets = ["ORCHID", "KESTREL", "thermal-anomaly", "radio-analysis"];
const capabilities = ["tool:confidential.search", "tool:confidential.present"];
const grant: Grant = {
  capabilities, effects: [{ type: "present", resource: "local-file", reversible: false }],
  disclosureDestinations: ["local", "remote"],
  budget: { maxDurationMs: 1_000, maxInstructions: 10_000, maxMemoryBytes: 8_000_000, maxOutputBytes: 2_000, maxToolCalls: 4, maxCallDepth: 8 }
};

async function fixture(scope = "retrieval-test") {
  const presented: string[] = [];
  const service = await ConfidentialRetrievalService.create({
    scope, embedder: new HashingEmbedder(), intentInterpreter: new LocalIntentInterpreter(),
    documents: [
      { id: "target", path: "classified/ORCHID/thermal-anomaly.pdf", content: "Actuator overheating observed during chamber testing." },
      { id: "decoy", path: "classified/KESTREL/radio-analysis.pdf", content: "Antenna interference measurements from the field trial." }
    ],
    present(file) { presented.push(file.documentId); }
  });
  return { service, presented };
}

function capsule(scope = "retrieval-test"): OrchestrationCapsule {
  return {
    version: "0.1", id: "find-file", kind: "orchestration", intent: "find a remembered file",
    capabilities, effects: grant.effects,
    disclosureBudget: { maxRemoteBytes: 128, allowedLabels: ["operation-status"] },
    inputs: { memory: guarded("PDF about a component overheating during a test", {
      ...defaultGuard(scope, "confidential"), provenance: ["user:remembered-description"], permittedOperations: ["semantic-search"]
    }) },
    workflow: { steps: [
      { id: "search", tool: "semantic file search", args: { description: { $ref: "memory" } }, assign: "searchState", next: "present" },
      { id: "present", tool: "open best confidential match", args: { search: { $ref: "searchState" } }, assign: "outcome", next: "done" },
      { id: "done", type: "return", result: { outcome: { $ref: "outcome" } } }
    ] }
  };
}

describe("confidential retrieval benchmark", () => {
  it("finds and presents the target while the model-visible receipt contains no index secrets", async () => {
    const { service, presented } = await fixture();
    const result = await run(capsule(), { tools: service.tools, grant });
    expect(presented).toEqual(["target"]);
    expect(result.receipt.remoteResult).toEqual({ outcome: { status: "presented_to_authorized_user" } });
    const transcript = JSON.stringify(result.receipt);
    for (const secret of secrets) expect(transcript).not.toContain(secret);
    expect(result.receipt.metrics.toolCalls).toBe(2);
  });

  it("does not expose raw matches from a search-only workflow", async () => {
    const { service } = await fixture();
    const searchOnly = capsule();
    searchOnly.capabilities = ["tool:confidential.search"];
    searchOnly.effects = [];
    searchOnly.workflow = { steps: [
      { id: "search", tool: "semantic file search", args: { description: { $ref: "memory" } }, assign: "matches", next: "done" },
      { id: "done", type: "return", result: { matches: { $ref: "matches" } } }
    ] };
    const result = await run(searchOnly, { tools: service.tools, grant });
    expect(JSON.stringify(result.receipt.remoteResult)).toMatch(/confidential-search/);
    for (const secret of secrets) expect(JSON.stringify(result.receipt)).not.toContain(secret);
  });

  it("rejects a search handle presented through a different session", async () => {
    const first = await fixture("session-a");
    const second = await fixture("session-b");
    const search = first.service.tools.get("confidential.search")!;
    const present = second.service.tools.get("confidential.present-best")!;
    const handle = await search.execute({ description: guarded("overheating test", defaultGuard("session-a")) }, { simulate: false, variables: {} });
    await expect(present.execute({ search: handle }, { simulate: false, variables: {} })).rejects.toThrow("HANDLE_SCOPE_VIOLATION");
  });
});
