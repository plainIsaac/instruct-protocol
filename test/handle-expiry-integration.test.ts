import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfidentialRetrievalService, HashingEmbedder, LocalIntentInterpreter,
  defaultGuard, guarded, HandleStore, type GuardedValue
} from "../src/index.js";
import { invokeTool, type ToolContext, type ToolDefinition } from "../src/tools.js";

const scope = "handle-expiry";
const now = new Date("2030-01-01T00:00:00.000Z");
const expiry = "2030-01-01T00:00:00.150Z";
const later = "2030-01-01T00:01:00.000Z";
const context: ToolContext = { simulate: false, variables: {} };
const invoke = (tool: ToolDefinition, args: Record<string, GuardedValue>, ctx = context) =>
  invokeTool(tool, args, ctx, performance.now() + 2_000);

async function fixture() {
  const presented: string[] = [];
  const service = await ConfidentialRetrievalService.create({
    scope, embedder: new HashingEmbedder(), intentInterpreter: new LocalIntentInterpreter(),
    documents: [{ id: "target", path: "private/test.pdf", content: "component overheating" }],
    present(file) { presented.push(file.documentId); }
  });
  return { search: service.tools.get("confidential.search")!, present: service.tools.get("confidential.present-best")!, presented };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe("authoritative confidential search handle expiry", () => {
  it.each(["guard", "descriptor"] as const)("persists the earliest implicit contributor %s deadline", async source => {
    const f = await fixture();
    const contributor = guarded(true, { ...defaultGuard(scope), expiresAt: source === "guard" ? expiry : later });
    if (source === "descriptor") contributor.handle = { id: "upstream", type: "dependency", scope, expiresAt: expiry };
    const result = await invoke(f.search, {
      description: guarded("component overheating", { ...defaultGuard(scope), expiresAt: later })
    }, { ...context, guardContributors: [contributor] });
    expect(result.guard.expiresAt).toBe(expiry);
    vi.setSystemTime(expiry);
    const resubmitted = structuredClone(result);
    delete resubmitted.guard.expiresAt;
    delete resubmitted.handle!.expiresAt;
    await expect(invoke(f.present, { search: resubmitted })).rejects.toThrow("HANDLE_EXPIRED");
    expect(f.presented).toEqual([]);
  });
  it("allows legitimate presentation just before expiry and returns the persisted deadline", async () => {
    const f = await fixture();
    const result = await invoke(f.search, { description: guarded("component overheating", { ...defaultGuard(scope), expiresAt: expiry }) });
    expect(result.handle?.expiresAt).toBe(expiry);
    vi.setSystemTime("2030-01-01T00:00:00.149Z");
    await expect(invoke(f.present, { search: result })).resolves.toMatchObject({ value: { status: "presented_to_authorized_user" } });
    expect(f.presented).toEqual(["target"]);
  });

  it.each(["remove", "extend"] as const)("ignores %s mutations to the actual returned search descriptor", async tamper => {
    const f = await fixture();
    const result = await invoke(f.search, { description: guarded("component overheating", { ...defaultGuard(scope), expiresAt: expiry }) });
    if (tamper === "remove") {
      delete result.guard.expiresAt;
      delete result.handle!.expiresAt;
    } else {
      result.guard.expiresAt = later;
      result.handle!.expiresAt = later;
    }
    vi.setSystemTime(expiry);
    await expect(invoke(f.present, { search: result })).rejects.toThrow("HANDLE_EXPIRED");
    expect(f.presented).toEqual([]);
  });

  it.each(["original", "descriptor", "resolved"] as const)("isolates authoritative state from %s aliases", source => {
    const store = new HandleStore(scope);
    const original = guarded({ candidates: ["target"] }, { ...defaultGuard(scope), expiresAt: expiry, correlation: "session" });
    const descriptor = store.create(original, "confidential-search");
    const handle = structuredClone(descriptor.handle!);
    const alias = source === "original" ? original : source === "descriptor" ? descriptor : store.resolve(handle);
    alias.guard.expiresAt = later;
    alias.guard.provenance.push("tampered");
    if (alias.value) (alias.value as { candidates: string[] }).candidates[0] = "decoy";
    if (alias.handle) alias.handle.expiresAt = later;
    expect(store.resolve(handle)).toMatchObject({ value: { candidates: ["target"] }, guard: { expiresAt: expiry, provenance: [] } });
    vi.setSystemTime(expiry);
    expect(() => store.resolve(handle)).toThrow("HANDLE_EXPIRED");
  });

  it.each(["remove", "extend"] as const)("rejects expired search state when resubmitted expiry metadata is %s", async tamper => {
    const f = await fixture();
    const result = await invoke(f.search, { description: guarded("component overheating", {
      ...defaultGuard(scope, "confidential"), permittedOperations: ["semantic-search"], expiresAt: expiry
    }) });
    expect(result.guard.expiresAt).toBe(expiry);
    vi.setSystemTime(expiry);
    await expect(invoke(f.present, { search: structuredClone(result) })).rejects.toThrow("TOOL_INPUT_EXPIRED");
    const resubmitted = structuredClone(result);
    if (tamper === "remove") {
      delete resubmitted.guard.expiresAt;
      delete resubmitted.handle!.expiresAt;
    } else {
      resubmitted.guard.expiresAt = later;
      resubmitted.handle!.expiresAt = later;
    }
    await expect(invoke(f.present, { search: resubmitted })).rejects.toThrow("HANDLE_EXPIRED");
    expect(f.presented).toEqual([]);
  });
});
