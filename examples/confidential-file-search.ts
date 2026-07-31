import {
  ConfidentialRetrievalService, HashingEmbedder, LocalIntentInterpreter,
  defaultGuard, guarded, run, type Grant, type OrchestrationCapsule
} from "../src/index.js";

const service = await ConfidentialRetrievalService.create({
  scope: "benchmark-session",
  embedder: new HashingEmbedder(),
  intentInterpreter: new LocalIntentInterpreter(),
  documents: [
    { id: "a", path: "classified/ORCHID/thermal-anomaly.pdf", content: "Actuator overheating observed during chamber testing." },
    { id: "b", path: "classified/KESTREL/radio-analysis.pdf", content: "Antenna interference measurements from the field trial." },
    { id: "c", path: "restricted/finance.xlsx", content: "Quarterly supplier cost forecast." }
  ],
  present(file) { console.log(`Trusted UI opened document ${file.documentId}.`); }
});

const capabilities = ["tool:confidential.search", "tool:confidential.present"];
const grant: Grant = {
  capabilities, effects: [{ type: "present", resource: "local-file", reversible: false }],
  disclosureDestinations: ["local", "remote"],
  budget: { maxDurationMs: 1_000, maxInstructions: 10_000, maxMemoryBytes: 8_000_000, maxOutputBytes: 1_000, maxToolCalls: 2, maxCallDepth: 4 }
};
const capsule: OrchestrationCapsule = {
  version: "0.1", id: "confidential-search", kind: "orchestration",
  intent: "Locate and present the file without disclosing indexed information",
  capabilities, effects: grant.effects,
  disclosureBudget: { maxRemoteBytes: 128, allowedLabels: ["operation-status"] },
  inputs: {
    memory: guarded("the PDF about a component overheating during a test", {
      ...defaultGuard("benchmark-session", "confidential"),
      provenance: ["user:remembered-description"], permittedOperations: ["semantic-search"]
    })
  },
  workflow: { steps: [
    { id: "search", tool: "semantic file search", args: { description: { $ref: "memory" } }, assign: "matches", next: "present" },
    { id: "present", tool: "open best confidential match", args: { search: { $ref: "matches" } }, assign: "outcome", next: "done" },
    { id: "done", type: "return", result: { outcome: { $ref: "outcome" } } }
  ] }
};

const result = await run(capsule, { tools: service.tools, grant });
console.log(result.receipt.remoteResult);
