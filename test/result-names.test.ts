import { describe, expect, it, vi } from "vitest";
import { finalizeRun } from "../src/finalize.js";
import { defaultGuard, guarded } from "../src/guarded.js";
import { emptyMetrics, EventRecorder } from "../src/observability.js";
import { verifyReceipt } from "../src/receipt.js";

async function finish(names: string[]) {
  return finalizeRun({
    recorder: new EventRecorder(), metrics: emptyMetrics(), status: "completed",
    instructionHash: "fixture", observedEffects: [],
    localResult: Object.fromEntries(names.map((name, index) => [name, guarded(index, {
      ...defaultGuard("result-names"), permittedDestinations: ["local", "remote"]
    })])),
    policy: { allowedLabels: [], destinations: ["local", "remote"], maxOutputBytes: 100_000, maxRemoteBytes: 100_000 }
  });
}

describe("lossless remote result names", () => {
  it("preserves ordinary valid identifiers", async () => {
    const { receipt } = await finish(["answer", "result_2", "a-b.c", "w"]);
    expect(receipt.remoteResult).toEqual({ answer: 0, result_2: 1, "a-b.c": 2, w: 3 });
    expect(verifyReceipt(receipt)).toBe(true);
  });

  it("does not overwrite a name already used by a positional fallback", async () => {
    const { receipt } = await finish(["result_2", "result", "bad name"]);
    expect(Object.values(receipt.remoteResult as object).sort()).toEqual([0, 1, 2]);
    expect(Object.keys(receipt.remoteResult as object)).toHaveLength(3);
    expect(verifyReceipt(receipt)).toBe(true);
  });

  it("does bounded naming work when many fallback suffixes are reserved", async () => {
    const names = [...Array.from({ length: 256 }, (_, i) => `invalid name ${i}`), "result", ...Array.from({ length: 256 }, (_, i) => `result_${i}`)];
    // Count actual membership work rather than assert a machine-dependent deadline.
    const membership = vi.spyOn(Set.prototype, "has");
    let checks: number;
    let receipt: Awaited<ReturnType<typeof finish>>["receipt"];
    try { ({ receipt } = await finish(names)); checks = membership.mock.calls.length; }
    finally { membership.mockRestore(); }
    expect(Object.keys(receipt!.remoteResult as object)).toHaveLength(names.length);
    expect(checks!).toBeLessThan(names.length * 20);
  });

  it("preserves every value across adversarial identifier combinations", async () => {
    const names = ["result", "result_1", "result_2", "result_3", "bad name", "another bad name", "__proto__", "constructor", "x".repeat(65)];
    for (let offset = 0; offset < names.length; offset++) {
      const order = [...names.slice(offset), ...names.slice(0, offset)];
      const { receipt } = await finish(order);
      const remote = receipt.remoteResult as Record<string, unknown>;
      expect(Object.keys(remote)).toHaveLength(order.length);
      expect(new Set(Object.values(remote)).size).toBe(order.length);
      expect(Object.keys(remote).every(name => /^[a-zA-Z][\w.-]{0,63}$/.test(name))).toBe(true);
      expect(verifyReceipt(receipt)).toBe(true);
    }
  });
});
