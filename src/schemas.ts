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
  if (capsule.kind !== "orchestration" && capsule.kind !== "code") errors.push("$.kind: expected orchestration|code");
  nonEmptyString(capsule.id, "$.id", errors);
  nonEmptyString(capsule.intent, "$.intent", errors);
  uniqueStrings(capsule.capabilities, "$.capabilities", errors);
  if (!Array.isArray(capsule.effects)) errors.push("$.effects: expected array");
  else capsule.effects.forEach((effect, index) => validateEffect(effect, `$.effects[${index}]`, errors));
  if (!isRecord(capsule.disclosureBudget)) errors.push("$.disclosureBudget: expected object");
  else {
    positiveInteger(capsule.disclosureBudget.maxRemoteBytes, "$.disclosureBudget.maxRemoteBytes", errors, true);
    uniqueStrings(capsule.disclosureBudget.allowedLabels, "$.disclosureBudget.allowedLabels", errors);
  }
  if (!isRecord(capsule.inputs)) errors.push("$.inputs: expected object");
  else for (const [name, input] of Object.entries(capsule.inputs)) validateGuardedValueAt(input, `$.inputs.${name}`, errors);
  if (capsule.kind === "orchestration") {
    if (!isRecord(capsule.workflow)) errors.push("$.workflow: required for orchestration");
    if ("program" in value) errors.push("$.program: not allowed for orchestration");
  }
  if (capsule.kind === "code") {
    if (!isRecord(capsule.program)) errors.push("$.program: required for code");
    else {
      if (capsule.program.language !== "lua") errors.push("$.program.language: expected lua");
      nonEmptyString(capsule.program.source, "$.program.source", errors);
      if (capsule.program.budget !== undefined) validateBudget(capsule.program.budget, "$.program.budget", errors, true);
    }
    if ("workflow" in value) errors.push("$.workflow: not allowed for code");
  }
  return [...new Set(errors)];
}

export function validateGuardedValue(value: unknown): string[] {
  const errors: string[] = [];
  validateGuardedValueAt(value, "$", errors);
  return errors;
}

function validateGuardedValueAt(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) { errors.push(`${path}: expected guarded value`); return; }
  if (value.kind !== "guarded") errors.push(`${path}.kind: expected guarded`);
  if (!Object.hasOwn(value, "value") && !Object.hasOwn(value, "handle")) errors.push(`${path}: value or handle required`);
  if (value.handle !== undefined) {
    if (!isRecord(value.handle)) errors.push(`${path}.handle: expected object`);
    else {
      nonEmptyString(value.handle.id, `${path}.handle.id`, errors);
      nonEmptyString(value.handle.type, `${path}.handle.type`, errors);
      nonEmptyString(value.handle.scope, `${path}.handle.scope`, errors);
      if (value.handle.expiresAt !== undefined && !validTimestamp(value.handle.expiresAt)) errors.push(`${path}.handle.expiresAt: invalid timestamp`);
    }
  }
  if (!isRecord(value.guard)) { errors.push(`${path}.guard: expected object`); return; }
  if (!["public", "internal", "confidential", "secret"].includes(String(value.guard.sensitivity))) errors.push(`${path}.guard.sensitivity: invalid`);
  for (const field of ["disclosures", "provenance", "sourceHandles", "transformations", "permittedOperations", "permittedDestinations"]) {
    if (!Array.isArray(value.guard[field])) errors.push(`${path}.guard.${field}: expected array`);
  }
  for (const field of ["disclosures", "provenance", "sourceHandles", "permittedOperations", "permittedDestinations"])
    uniqueStrings(value.guard[field], `${path}.guard.${field}`, errors);
  if (Array.isArray(value.guard.transformations)) value.guard.transformations.forEach((record, index) => validateTransformation(record, `${path}.guard.transformations[${index}]`, errors));
  nonEmptyString(value.guard.scope, `${path}.guard.scope`, errors);
  if (!["single-use", "session", "persistent"].includes(String(value.guard.correlation))) errors.push(`${path}.guard.correlation: invalid`);
  if (value.guard.expiresAt !== undefined && !validTimestamp(value.guard.expiresAt)) errors.push(`${path}.guard.expiresAt: invalid timestamp`);
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

function validateEffect(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) { errors.push(`${path}: expected object`); return; }
  nonEmptyString(value.type, `${path}.type`, errors);
  if (value.resource !== undefined) nonEmptyString(value.resource, `${path}.resource`, errors);
  if (value.reversible !== undefined && typeof value.reversible !== "boolean") errors.push(`${path}.reversible: expected boolean`);
}
function validateBudget(value: unknown, path: string, errors: string[], partial = false): void {
  if (!isRecord(value)) { errors.push(`${path}: expected object`); return; }
  for (const field of ["maxDurationMs", "maxInstructions", "maxMemoryBytes", "maxOutputBytes", "maxToolCalls", "maxCallDepth"]) {
    if (!partial && !Object.hasOwn(value, field)) errors.push(`${path}.${field}: required`);
    else if (Object.hasOwn(value, field)) positiveInteger(value[field], `${path}.${field}`, errors);
  }
}
function validateTransformation(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) { errors.push(`${path}: expected object`); return; }
  nonEmptyString(value.name, `${path}.name`, errors);
  if (typeof value.trusted !== "boolean") errors.push(`${path}.trusted: expected boolean`);
  uniqueStrings(value.guarantees, `${path}.guarantees`, errors);
  uniqueStrings(value.inputProvenance, `${path}.inputProvenance`, errors);
  if (!validTimestamp(value.at)) errors.push(`${path}.at: invalid timestamp`);
}
function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}
