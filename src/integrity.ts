import { sign, verify, type KeyObject } from "node:crypto";
import type { ReceiptSignatureVerifier, ReceiptSigner } from "./receipt.js";

export const ED25519_RECEIPT_PROFILE = "instruct-reference-ed25519-v1";

/** Adapter for a key supplied by a deployment keystore; this class does not load keys. */
export class Ed25519ReceiptSigner implements ReceiptSigner {
  readonly profile = ED25519_RECEIPT_PROFILE;
  constructor(readonly keyId: string, private readonly privateKey: KeyObject) {
    if (!keyId || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("INVALID_ED25519_SIGNER");
  }
  sign(digest: Uint8Array): Uint8Array { return sign(null, digest, this.privateKey); }
}

/** Key resolution stays with the deployment so rotation and HSM policy remain external. */
export class Ed25519ReceiptVerifier implements ReceiptSignatureVerifier {
  constructor(private readonly resolveKey: (keyId: string) => KeyObject | undefined) {}
  verify(profile: string, keyId: string, digest: Uint8Array, signature: Uint8Array): boolean {
    if (profile !== ED25519_RECEIPT_PROFILE) return false;
    const key = this.resolveKey(keyId);
    return Boolean(key && key.type === "public" && key.asymmetricKeyType === "ed25519" && verify(null, digest, key, signature));
  }
}
