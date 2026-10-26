import { ProtocolError } from "./errors.js";
import { timingSafeEqual } from "node:crypto";
import type { Effect, ExecutionEvent, ExecutionMetrics, ExecutionReceipt, ReceiptIntegrity } from "./types.js";
import { referenceDigest } from "./canonical.js";

export function createReceipt(input: { instructionHash: string; canonicalHash?: string; status: ExecutionReceipt["status"]; events: ExecutionEvent[]; remoteResult: unknown; observedEffects: Effect[]; metrics: ExecutionMetrics; previousHash?: string }): ExecutionReceipt {
  const previousHash = input.previousHash ?? "0".repeat(64);
  const body = { version: "0.1" as const, instructionHash: input.instructionHash, canonicalHash: input.canonicalHash, previousHash, status: input.status, events: input.events, metrics: input.metrics, remoteResult: input.remoteResult, observedEffects: input.observedEffects };
  return { ...body, receiptHash: referenceDigest(body) };
}
export function verifyReceipt(receipt: ExecutionReceipt): boolean {
  try {
    if (!receipt || typeof receipt !== "object" || !/^[a-f0-9]{64}$/.test(receipt.receiptHash)) return false;
    const { receiptHash, integrity: _integrity, ...body } = receipt;
    return timingSafeEqual(Buffer.from(referenceDigest(body), "hex"), Buffer.from(receiptHash, "hex"));
  } catch { return false; }
}

export interface ReceiptSigner {
  readonly profile: string;
  readonly keyId: string;
  sign(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export interface ReceiptSignatureVerifier {
  verify(profile: string, keyId: string, digest: Uint8Array, signature: Uint8Array): Promise<boolean> | boolean;
}

export async function signReceipt(receipt: ExecutionReceipt, signer: ReceiptSigner): Promise<ExecutionReceipt> {
  if (!verifyReceipt(receipt)) throw new ProtocolError("INVALID_RECEIPT_DIGEST");
  if (!signer.profile || !signer.keyId) throw new ProtocolError("INVALID_RECEIPT_SIGNER");
  const signature = await signer.sign(Buffer.from(receipt.receiptHash, "hex"));
  if (!(signature instanceof Uint8Array) || signature.byteLength === 0) throw new ProtocolError("INVALID_RECEIPT_SIGNATURE");
  const integrity: ReceiptIntegrity = { profile: signer.profile, keyId: signer.keyId, signature: Buffer.from(signature).toString("base64url") };
  return { ...receipt, integrity };
}

export async function verifyReceiptSignature(receipt: ExecutionReceipt, verifier: ReceiptSignatureVerifier): Promise<boolean> {
  try {
    if (!verifyReceipt(receipt) || !receipt.integrity) return false;
    const signature = Buffer.from(receipt.integrity.signature, "base64url");
    if (!signature.byteLength) return false;
    return await verifier.verify(receipt.integrity.profile, receipt.integrity.keyId, Buffer.from(receipt.receiptHash, "hex"), signature);
  } catch { return false; }
}
