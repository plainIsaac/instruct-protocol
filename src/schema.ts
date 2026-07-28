import type { JsonSchema } from "./types.js";

export function validateSchema(value: unknown, schema?: JsonSchema, path = "$"): string[] {
  if (!schema) return [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  if (actual === "object" && value) {
    const object = value as Record<string, unknown>; const errors: string[] = [];
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in object) errors.push(...validateSchema(object[key], child, `${path}.${key}`));
    if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!schema.properties?.[key]) errors.push(`${path}.${key}: additional property`);
    return errors;
  }
  if (actual === "array" && schema.items) return (value as unknown[]).flatMap((item, i) => validateSchema(item, schema.items, `${path}[${i}]`));
  return [];
}
