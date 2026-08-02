import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Ed25519ReceiptSigner, Ed25519ReceiptVerifier, SecurityAuditObserver, ToolRegistry,
  defaultGuard, guarded, processTool, run, verifyReceiptSignature,
  type CodeCapsule, type Grant, type OrchestrationCapsule
} from "../src/index.js";

const budget = { maxDurationMs: 2_000, maxInstructions: 1_000, maxMemoryBytes: 1_000_000, maxOutputBytes: 1_000, maxToolCalls: 4, maxCallDepth: 4 };
const grant: Grant = { capabilities: ["code:execute", "tool:effect"], effects: [{ type: "write", resource: "fixture", reversible: true }], disclosureDestinations: ["local", "remote"], budget };

function signing() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    signer: new Ed25519ReceiptSigner("test-key", privateKey),
    verifier: new Ed25519ReceiptVerifier(keyId => keyId === "test-key" ? publicKey : undefined)
  };
}

function audit() {
  const lines: string[] = []; const alerts: string[] = [];
  return { observer: new SecurityAuditObserver({ write: line => lines.push(line) }, { alert: value => alerts.push(value.code) }), lines, alerts };
}

describe("reference production profile", () => {
  it("authenticates receipts and rejects tampering", async () => {
    const { signer, verifier } = signing(); const { observer, lines } = audit();
    const capsule: CodeCapsule = {
      version: "0.1", id: "signed", kind: "code", intent: "signed result",
      capabilities: ["code:execute"], effects: [], disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] },
      inputs: {}, program: { language: "lua", source: "function main(ctx) return 7 end" }
    };
    const result = await run(capsule, { tools: new ToolRegistry(), grant, production: { receiptSigner: signer, auditObserver: observer } });
    expect(result.receipt.integrity).toMatchObject({ profile: "instruct-reference-ed25519-v1", keyId: "test-key" });
    expect(await verifyReceiptSignature(result.receipt, verifier)).toBe(true);
    expect(await verifyReceiptSignature({ ...result.receipt, remoteResult: { changed: true } }, verifier)).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("rejects effectful in-process tools in production mode", async () => {
    const tools = new ToolRegistry().register({
      name: "fixture.effect", capability: "tool:effect", effects: grant.effects,
      execute: async () => guarded("ok", defaultGuard("fixture"))
    });
    const capsule: OrchestrationCapsule = {
      version: "0.1", id: "in-process", kind: "orchestration", intent: "effect",
      capabilities: ["tool:effect"], effects: grant.effects, disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {},
      workflow: { steps: [{ id: "effect", tool: "fixture.effect" }] }
    };
    const { signer } = signing(); const { observer } = audit();
    await expect(run(capsule, { tools, grant, production: { receiptSigner: signer, auditObserver: observer } }))
      .rejects.toThrow("PRODUCTION_TOOL_NOT_ISOLATED");
  });

  it("runs an effectful tool behind a terminable process boundary", async () => {
    const child = `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({kind:'guarded',value:'ok',guard:{sensitivity:'public',disclosures:[],provenance:[],sourceHandles:[],transformations:[],permittedOperations:[],permittedDestinations:['local','remote'],scope:'child',correlation:'single-use'}})))`;
    const tools = new ToolRegistry().register(processTool({
      name: "fixture.process-effect", capability: "tool:effect", effects: grant.effects,
      command: process.execPath, args: ["-e", child]
    }));
    const capsule: OrchestrationCapsule = {
      version: "0.1", id: "process", kind: "orchestration", intent: "isolated effect",
      capabilities: ["tool:effect"], effects: grant.effects, disclosureBudget: { maxRemoteBytes: 100, allowedLabels: [] }, inputs: {},
      workflow: { steps: [
        { id: "effect", tool: "fixture.process-effect", assign: "answer", next: "done" },
        { id: "done", type: "return", result: { answer: { $ref: "answer" } } }
      ] }
    };
    const { signer, verifier } = signing(); const { observer } = audit();
    const result = await run(capsule, { tools, grant, production: { receiptSigner: signer, auditObserver: observer } });
    expect(result.receipt.status).toBe("completed");
    expect(await verifyReceiptSignature(result.receipt, verifier)).toBe(true);
  });

  it("forcibly terminates an isolated tool when its signal is aborted", async () => {
    const tool = processTool({
      name: "fixture.abort", capability: "tool:effect", effects: grant.effects,
      command: process.execPath, args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"]
    });
    const controller = new AbortController();
    const invocation = tool.execute({}, { signal: controller.signal, simulate: false, variables: {} });
    setTimeout(() => controller.abort(), 20);
    await expect(invocation).rejects.toThrow("PROCESS_TOOL_ABORTED");
  });
});
