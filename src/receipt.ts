import { createHash } from "node:crypto";
import type { Effect, ExecutionEvent, ExecutionMetrics, ExecutionReceipt } from "./types.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createReceipt(input: { instructionHash: string; canonicalHash?: string; status: ExecutionReceipt["status"]; events: ExecutionEvent[]; remoteResult: unknown; observedEffects: Effect[]; metrics: ExecutionMetrics; previousHash?: string }): ExecutionReceipt {
  const previousHash = input.previousHash ?? "0".repeat(64);
  const body = { version: "0.1" as const, instructionHash: input.instructionHash, canonicalHash: input.canonicalHash, previousHash, status: input.status, events: input.events, metrics: input.metrics, remoteResult: input.remoteResult, observedEffects: input.observedEffects };
  return { ...body, receiptHash: hash(body) };
}
export function verifyReceipt(receipt: ExecutionReceipt): boolean { const { receiptHash, ...body } = receipt; return hash(body) === receiptHash; }
