import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfidentialRetrievalService, HashingEmbedder, LocalIntentInterpreter,
  ToolRegistry, Ed25519ReceiptSigner, Ed25519ReceiptVerifier, SecurityAuditObserver,
  defaultGuard, guarded, processTool, run, verifyReceipt, verifyReceiptSignature
} from "instruct-protocol";
import * as schemas from "instruct-protocol/schemas";

// Runs from a clean consumer directory, against the installed tarball only.
const completed = [];
const budget = { maxDurationMs: 3_000, maxInstructions: 100_000, maxMemoryBytes: 8_000_000, maxOutputBytes: 16_000, maxToolCalls: 8, maxCallDepth: 8 };
const grant = { capabilities: [], effects: [], disclosureDestinations: ["local", "remote"], budget };
const keys = generateKeyPairSync("ed25519");
const signer = new Ed25519ReceiptSigner("consumer-test", keys.privateKey);
const verifier = new Ed25519ReceiptVerifier(id => id === "consumer-test" ? keys.publicKey : undefined);
const audit = [];
const observer = new SecurityAuditObserver({ write: line => audit.push(line) }, { alert() {} });
function capsule(kind, values = {}) {
  return { version: "0.1", id: "package-consumer", kind, intent: "exercise installed public API", capabilities: [], effects: [], disclosureBudget: { maxRemoteBytes: 8_000, allowedLabels: [] }, inputs: {}, ...values };
}
async function validReceipt(result) {
  assert.equal(verifyReceipt(result.receipt), true);
  assert.equal(await verifyReceiptSignature(result.receipt, verifier), true);
}
function signed(options = {}) { return { tools: new ToolRegistry(), grant, receiptSigner: signer, ...options }; }

assert.equal(typeof schemas.validateInstructionCapsule, "function");
const scalar = await run(capsule("code", {
  capabilities: ["code:execute"], program: { language: "lua", source: "function main(ctx) return 42 end" }
}), signed({ grant: { ...grant, capabilities: ["code:execute"] } }));
assert.equal(scalar.receipt.status, "completed");
assert.equal(scalar.localResult.result.value, 42);
await validReceipt(scalar);
completed.push("installed Lua worker and authenticated receipt");
const altered = structuredClone(scalar.receipt); altered.status = "failed";
assert.equal(verifyReceipt(altered), false);
assert.equal(await verifyReceiptSignature(altered, verifier), false);
completed.push("receipt tampering rejected");

const privateDir = await mkdtemp(join(tmpdir(), "instruct-corpus-"));
try {
  const secret = "ORCHID_PRIVATE_CANARY_9B7";
  const secretPath = join(privateDir, "ORCHID-private-design.txt");
  await writeFile(secretPath, `Actuator overheating chamber testing thermal anomaly. ${secret}`);
  const shown = [];
  const service = await ConfidentialRetrievalService.create({
    scope: "consumer-retrieval", embedder: new HashingEmbedder(), intentInterpreter: new LocalIntentInterpreter(),
    documents: [
      { id: "thermal", path: secretPath, content: await readFile(secretPath, "utf8") },
      { id: "other", path: join(privateDir, "other.txt"), content: "Quarterly supplier forecast costs." }
    ],
    present: async file => { shown.push({ id: file.documentId, content: await readFile(file.path, "utf8") }); }
  });
  const caps = ["tool:confidential.search", "tool:confidential.present"];
  const effects = [{ type: "present", resource: "local-file", reversible: false }];
  const request = capsule("orchestration", {
    capabilities: caps, effects, disclosureBudget: { maxRemoteBytes: 512, allowedLabels: ["operation-status"] },
    inputs: { query: guarded("Actuator overheating chamber testing thermal anomaly", {
      ...defaultGuard("consumer-retrieval", "confidential"), permittedOperations: ["semantic-search"]
    }) },
    workflow: { steps: [
      { id: "search", tool: "semantic file search", args: { description: { $ref: "query" } }, assign: "matches", next: "present" },
      { id: "present", tool: "open best confidential match", args: { search: { $ref: "matches" } }, assign: "outcome", next: "done" },
      { id: "done", type: "return", result: { outcome: { $ref: "outcome" } } }
    ] }
  });
  const options = signed({ tools: service.tools, grant: { ...grant, capabilities: caps, effects }, observer });
  const result = await run(request, options);
  assert.equal(result.receipt.status, "completed");
  assert.equal(shown.length, 1); assert.equal(shown[0].id, "thermal"); assert.ok(shown[0].content.includes(secret));
  assert.deepEqual(result.receipt.remoteResult, { outcome: { status: "presented_to_authorized_user" } });
  const remote = JSON.stringify({ receipt: result.receipt, audit });
  for (const canary of [secret, secretPath, "ORCHID-private-design"]) assert.equal(remote.includes(canary), false);
  await validReceipt(result);
  completed.push("filesystem-backed confidential search and local presentation without corpus disclosure");

  const denied = await run(request, { ...options, grant: { ...options.grant, capabilities: [] } });
  assert.equal(denied.receipt.status, "denied"); assert.equal(shown.length, 1);
  await validReceipt(denied);
  completed.push("unauthorized retrieval denied before presentation");
} finally { await rm(privateDir, { recursive: true, force: true }); }

const effect = { type: "write", resource: "consumer-fixture", reversible: true };
const response = guarded("process-ok", { ...defaultGuard("consumer"), permittedDestinations: ["local", "remote"] });
const isolated = processTool({
  name: "consumer.write", capability: "tool:write", effects: [effect],
  command: process.execPath,
  args: ["-e", `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(response))}))`]
});
const tools = new ToolRegistry().register(isolated);
const processRequest = capsule("orchestration", {
  capabilities: ["tool:write"], effects: [effect],
  workflow: { steps: [
    { id: "write", tool: "consumer.write", assign: "value", next: "done" },
    { id: "done", type: "return", result: { value: { $ref: "value" } } }
  ] }
});
const processOptions = {
  tools, grant: { ...grant, capabilities: ["tool:write"], effects: [effect] },
  production: { receiptSigner: signer, auditObserver: observer }
};
const processResult = await run(processRequest, processOptions);
assert.equal(processResult.receipt.status, "completed");
assert.equal(processResult.localResult.value.value, "process-ok");
assert.deepEqual(processResult.receipt.observedEffects, [effect]);
await validReceipt(processResult);
completed.push("process-isolated production-profile tool and signed audit receipt");

const failing = new ToolRegistry().register({
  name: "consumer.write", capability: "tool:write", effects: [effect],
  async execute() { throw new Error("PRIVATE_EXCEPTION_CANARY_4D2"); }
});
const failed = await run(processRequest, signed({ tools: failing, grant: processOptions.grant, observer }));
assert.equal(failed.receipt.status, "failed");
assert.equal(JSON.stringify({ receipt: failed.receipt, audit }).includes("PRIVATE_EXCEPTION_CANARY_4D2"), false);
await validReceipt(failed);
completed.push("tool failure returns a sanitized verifiable receipt");

const abort = new AbortController(); abort.abort();
const cancelled = await run(capsule("code", {
  capabilities: ["code:execute"], program: { language: "lua", source: "function main(ctx) return 1 end" }
}), signed({ grant: { ...grant, capabilities: ["code:execute"] }, signal: abort.signal }));
assert.equal(cancelled.receipt.status, "failed");
await validReceipt(cancelled);
completed.push("caller cancellation prevents Lua execution");

let restrictedCalls = 0;
const restrictedTools = new ToolRegistry().register({
  name: "consumer.read", capability: "tool:read", effects: [],
  async execute() { restrictedCalls++; return guarded("not-authorized", defaultGuard("consumer")); }
});
const restricted = await run(capsule("orchestration", {
  capabilities: ["tool:read"],
  inputs: { private: guarded("GUARDED_ARGUMENT_CANARY", {
    ...defaultGuard("consumer", "secret"), permittedOperations: [], permittedDestinations: ["local"]
  }) },
  workflow: { steps: [
    { id: "read", tool: "consumer.read", args: { value: { $ref: "private" } }, next: "done" },
    { id: "done", type: "return", result: { ok: true } }
  ] }
}), signed({ tools: restrictedTools, grant: { ...grant, capabilities: ["tool:read"] } }));
assert.notEqual(restricted.receipt.status, "completed");
assert.equal(restrictedCalls, 0);
await validReceipt(restricted);
completed.push("guard restrictions enforced before tool execution");

const timeoutDir = await mkdtemp(join(tmpdir(), "instruct-process-timeout-"));
try {
  const marker = join(timeoutDir, "late-effect.txt");
  const slow = processTool({
    name: "consumer.write", capability: "tool:write", effects: [effect], command: process.execPath,
    args: ["-e", `const fs=require('node:fs');process.stdin.resume();setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),250);setInterval(()=>{},1000)`]
  });
  const timeoutResult = await run(processRequest, {
    ...processOptions, tools: new ToolRegistry().register(slow),
    grant: { ...processOptions.grant, budget: { ...budget, maxDurationMs: 100 } }
  });
  assert.equal(timeoutResult.receipt.status, "failed");
  await validReceipt(timeoutResult);
  await new Promise(resolve => setTimeout(resolve, 400));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  completed.push("timed-out process is terminated before a delayed filesystem effect");
} finally { await rm(timeoutDir, { recursive: true, force: true }); }
console.log(JSON.stringify({ packageConsumer: "passed", scenarios: completed.length, checks: completed }, null, 2));
