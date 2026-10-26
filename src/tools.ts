import { ProtocolError } from "./errors.js";
import type { Effect, GuardedValue, JsonSchema } from "./types.js";
import { validateSchema } from "./schema.js";
import { validateGuardedValue } from "./schemas.js";
import { assertDestination, mergeGuards } from "./guarded.js";

export interface ToolContext {
  signal?: AbortSignal; simulate: boolean; variables: Readonly<Record<string, GuardedValue>>;
  /** Additional guarded dependencies (for example all values a Lua program has seen).
   * Checked even for calls with no arguments, and inherited by ordinary outputs. */
  guardContributors?: readonly GuardedValue[];
}
export interface ToolDefinition {
  name: string; aliases?: string[]; capability: string; effects: Effect[];
  /** Every operation required of each argument; defaults to [capability]. */
  operations?: string[];
  /** Host-authorized guard replacement. The host must audit the implementation and guarantees.
   * Returned transformation records alone never authorize declassification. */
  outputTransform?: { name: string; guarantees: string[] };
  isolation?: "in-process" | "process";
  /** The tool tolerates repeated invocation with the same arguments; permits retrying irreversible effects. */
  idempotent?: boolean;
  inputSchema?: JsonSchema; outputSchema?: JsonSchema;
  execute(args: Record<string, GuardedValue>, context: ToolContext): Promise<GuardedValue>;
  simulate?(args: Record<string, GuardedValue>, context: ToolContext): Promise<GuardedValue>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): this {
    assertToolDefinition(tool);
    if (this.#tools.has(tool.name)) throw new ProtocolError(`DUPLICATE_TOOL:${tool.name}`);
    const names = [tool.name, ...(tool.aliases ?? [])].map(normalizeName);
    for (const existing of this.#tools.values()) if ([existing.name, ...(existing.aliases ?? [])].map(normalizeName).some(name => names.includes(name))) throw new ProtocolError(`AMBIGUOUS_TOOL_NAME:${tool.name}`);
    this.#tools.set(tool.name, Object.freeze({
      ...tool, aliases: tool.aliases ? [...tool.aliases] : undefined, effects: tool.effects.map(effect => ({ ...effect })),
      operations: tool.operations ? [...tool.operations] : undefined,
      outputTransform: tool.outputTransform ? { ...tool.outputTransform, guarantees: [...tool.outputTransform.guarantees] } : undefined
    })); return this;
  }
  get(name: string): ToolDefinition | undefined { return this.#tools.get(name); }
  resolve(name: string): ToolDefinition | undefined {
    const normalized = normalizeName(name);
    return [...this.#tools.values()].find(t => [t.name, ...(t.aliases ?? [])].some(x => normalizeName(x) === normalized));
  }
  list(): ToolDefinition[] { return [...this.#tools.values()]; }
}

const normalizeName = (name: string): string => name.trim().toLowerCase().replace(/[\s_-]+/g, "");

function assertToolDefinition(tool: ToolDefinition): void {
  const nonEmptyStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.trim().length > 0) && new Set(value).size === value.length;
  if (!tool || !/^[a-zA-Z][\w.-]{0,127}$/.test(tool.name) || typeof tool.capability !== "string" || !tool.capability.trim() || !Array.isArray(tool.effects) || typeof tool.execute !== "function"
    || (tool.operations !== undefined && !nonEmptyStrings(tool.operations))
    || (tool.outputTransform !== undefined && (!tool.outputTransform || typeof tool.outputTransform.name !== "string" || !tool.outputTransform.name.trim() || !nonEmptyStrings(tool.outputTransform.guarantees)))) throw new ProtocolError("INVALID_TOOL_DEFINITION");
}

/**
 * Invokes a tool with schema validation on both sides and a hard deadline. Tool
 * output must be a well-formed guarded value; anything else fails closed.
 */
export async function invokeTool(tool: ToolDefinition, args: Record<string, GuardedValue>, context: ToolContext, deadline: number, onInvoked?: () => void): Promise<GuardedValue> {
  assertToolDefinition(tool);
  const inputs = [...Object.values(args), ...(context.guardContributors ?? [])];
  for (const value of inputs) {
    if (validateGuardedValue(value).length) throw new ProtocolError("TOOL_INPUT_INVALID");
    if ([value.guard.expiresAt, value.handle?.expiresAt].some(expiry => expiry !== undefined && Date.parse(expiry) <= Date.now())) throw new ProtocolError("TOOL_INPUT_EXPIRED");
    if (!value.guard.permittedOperations.includes("*") && !(tool.operations ?? [tool.capability]).every(operation => value.guard.permittedOperations.includes(operation))) throw new ProtocolError("TOOL_OPERATION_DENIED");
    try { assertDestination(value, `tool:${tool.name}`); }
    catch { throw new ProtocolError("TOOL_DESTINATION_DENIED"); }
  }
  const plain = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v.value]));
  const schemaErrors = validateSchema(plain, tool.inputSchema);
  if (schemaErrors.length) throw new ProtocolError(`TOOL_SCHEMA_INVALID:${schemaErrors.join(";")}`);
  if (context.signal?.aborted) throw new ProtocolError("EXECUTION_ABORTED");
  if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new ProtocolError("WORKFLOW_TIMEOUT");
  // Mark entry before calling so synchronous execution failures still count.
  onInvoked?.();
  const operation = context.simulate && tool.simulate ? tool.simulate(args, context) : tool.execute(args, context);
  const output = await beforeDeadline(operation, deadline);
  const outputErrors = validateGuardedValue(output);
  if (outputErrors.length) throw new ProtocolError(`TOOL_OUTPUT_INVALID:${outputErrors.join(";")}`);
  const outputSchemaErrors = validateSchema(output.value, tool.outputSchema);
  if (outputSchemaErrors.length) throw new ProtocolError(`TOOL_OUTPUT_SCHEMA_INVALID:${outputSchemaErrors.join(";")}`);
  const contributors = [output, ...inputs];
  const merged = mergeGuards(contributors, tool.outputTransform ? { ...tool.outputTransform, trusted: true } : undefined);
  const guard = tool.outputTransform ? {
    ...output.guard, provenance: merged.provenance, sourceHandles: merged.sourceHandles,
    transformations: merged.transformations, expiresAt: merged.expiresAt
  } : merged;
  if ([guard.expiresAt, output.handle?.expiresAt].some(expiry => expiry !== undefined && Date.parse(expiry) <= Date.now())) throw new ProtocolError("TOOL_OUTPUT_EXPIRED");
  return { ...output, guard };
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new ProtocolError("WORKFLOW_TIMEOUT");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProtocolError("WORKFLOW_TIMEOUT")), remaining); })]);
  } finally { if (timer) clearTimeout(timer); }
}
