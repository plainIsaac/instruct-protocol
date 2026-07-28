import type { JsonSchema } from "./types.js";

export const instructionCapsuleSchema: JsonSchema = {
  type: "object", required: ["version", "id", "kind", "intent", "capabilities", "effects", "disclosureBudget", "inputs"],
  properties: { version: { type: "string" }, id: { type: "string" }, kind: { type: "string" }, intent: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, effects: { type: "array" }, disclosureBudget: { type: "object" }, inputs: { type: "object" }, workflow: { type: "object" }, program: { type: "object" } }
};
export const canonicalWorkflowSchema: JsonSchema = { type: "object", required: ["version", "entry", "nodes", "declaredCapabilities", "declaredEffects"], properties: { version: { type: "string" }, entry: { type: "string" }, nodes: { type: "object" }, declaredCapabilities: { type: "array" }, declaredEffects: { type: "array" } } };
export const guardedValueSchema: JsonSchema = { type: "object", required: ["kind", "guard"], properties: { kind: { type: "string" }, value: {}, handle: { type: "object" }, guard: { type: "object" } } };
