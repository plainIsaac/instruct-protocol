import type { InstructionCapsule, JsonSchema } from "./types.js";
import { validateSchema } from "./schema.js";

export const instructionCapsuleSchema: JsonSchema = {
  type: "object", required: ["version", "id", "kind", "intent", "capabilities", "effects", "disclosureBudget", "inputs"],
  properties: { version: { type: "string" }, id: { type: "string" }, kind: { type: "string" }, intent: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, effects: { type: "array" }, disclosureBudget: { type: "object" }, inputs: { type: "object" }, workflow: { type: "object" }, program: { type: "object" } }
};
export const canonicalWorkflowSchema: JsonSchema = { type: "object", required: ["version", "entry", "nodes", "declaredCapabilities", "declaredEffects"], properties: { version: { type: "string" }, entry: { type: "string" }, nodes: { type: "object" }, declaredCapabilities: { type: "array" }, declaredEffects: { type: "array" } } };
export const guardedValueSchema: JsonSchema = { type: "object", required: ["kind", "guard"], properties: { kind: { type: "string" }, value: {}, handle: { type: "object" }, guard: { type: "object" } } };

/** Structural and security-relevant validation at the untrusted capsule boundary. */
export function validateInstructionCapsule(value: unknown): string[] {
  const errors = validateSchema(value, instructionCapsuleSchema);
  if (!isRecord(value)) return errors;
  const capsule = value as unknown as InstructionCapsule;
  if (capsule.version !== "0.1") errors.push("$.version: unsupported");
  if (capsule.kind !== "orchestration" && capsule.kind !== "code") errors.push("$.kind: expected orchestration|code");
  nonEmptyString(capsule.id, "$.id", errors);
  nonEmptyString(capsule.intent, "$.intent", errors);
  uniqueStrings(capsule.capabilities, "$.capabilities", errors);
  if (!Array.isArray(capsule.effects)) errors.push("$.effects: expected array");
  if (!isRecord(capsule.disclosureBudget)) errors.push("$.disclosureBudget: expected object");
  else {
    positiveInteger(capsule.disclosureBudget.maxRemoteBytes, "$.disclosureBudget.maxRemoteBytes", errors, true);
    uniqueStrings(capsule.disclosureBudget.allowedLabels, "$.disclosureBudget.allowedLabels", errors);
  }
  if (!isRecord(capsule.inputs)) errors.push("$.inputs: expected object");
  else for (const [name, input] of Object.entries(capsule.inputs)) validateGuardedValue(input, `$.inputs.${name}`, errors);
  if (capsule.kind === "orchestration") {
    if (!isRecord(capsule.workflow)) errors.push("$.workflow: required for orchestration");
    if ("program" in value) errors.push("$.program: not allowed for orchestration");
  }
  if (capsule.kind === "code") {
    if (!isRecord(capsule.program)) errors.push("$.program: required for code");
    else {
      if (capsule.program.language !== "lua") errors.push("$.program.language: expected lua");
      nonEmptyString(capsule.program.source, "$.program.source", errors);
    }
    if ("workflow" in value) errors.push("$.workflow: not allowed for code");
  }
  return [...new Set(errors)];
}

function validateGuardedValue(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) { errors.push(`${path}: expected guarded value`); return; }
  if (value.kind !== "guarded") errors.push(`${path}.kind: expected guarded`);
  if (!("value" in value) && !("handle" in value)) errors.push(`${path}: value or handle required`);
  if (!isRecord(value.guard)) { errors.push(`${path}.guard: expected object`); return; }
  if (!["public", "internal", "confidential", "secret"].includes(String(value.guard.sensitivity))) errors.push(`${path}.guard.sensitivity: invalid`);
  for (const field of ["disclosures", "provenance", "sourceHandles", "transformations", "permittedOperations", "permittedDestinations"]) {
    if (!Array.isArray(value.guard[field])) errors.push(`${path}.guard.${field}: expected array`);
  }
  nonEmptyString(value.guard.scope, `${path}.guard.scope`, errors);
  if (!["single-use", "session", "persistent"].includes(String(value.guard.correlation))) errors.push(`${path}.guard.correlation: invalid`);
  if (value.guard.expiresAt !== undefined && !Number.isFinite(Date.parse(String(value.guard.expiresAt)))) errors.push(`${path}.guard.expiresAt: invalid timestamp`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) errors.push(`${path}: expected non-empty string`);
}
function uniqueStrings(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) { errors.push(`${path}: expected non-empty string array`); return; }
  if (new Set(value).size !== value.length) errors.push(`${path}: duplicate values`);
}
function positiveInteger(value: unknown, path: string, errors: string[], allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) errors.push(`${path}: expected ${allowZero ? "non-negative" : "positive"} integer`);
}
