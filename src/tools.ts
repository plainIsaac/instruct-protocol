import { ProtocolError } from "./errors.js";
import type { Effect, GuardedValue, JsonSchema } from "./types.js";
import { validateSchema } from "./schema.js";
import { validateGuardedValue } from "./schemas.js";

export interface ToolContext { signal?: AbortSignal; simulate: boolean; variables: Readonly<Record<string, GuardedValue>> }
export interface ToolDefinition {
  name: string; aliases?: string[]; capability: string; effects: Effect[];
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
    if (!tool || !/^[a-zA-Z][\w.-]{0,127}$/.test(tool.name) || !tool.capability || !Array.isArray(tool.effects) || typeof tool.execute !== "function") throw new ProtocolError("INVALID_TOOL_DEFINITION");
    if (this.#tools.has(tool.name)) throw new ProtocolError(`DUPLICATE_TOOL:${tool.name}`);
    const names = [tool.name, ...(tool.aliases ?? [])].map(normalizeName);
    for (const existing of this.#tools.values()) if ([existing.name, ...(existing.aliases ?? [])].map(normalizeName).some(name => names.includes(name))) throw new ProtocolError(`AMBIGUOUS_TOOL_NAME:${tool.name}`);
    this.#tools.set(tool.name, Object.freeze({ ...tool, aliases: tool.aliases ? [...tool.aliases] : undefined, effects: tool.effects.map(effect => ({ ...effect })) })); return this;
  }
  get(name: string): ToolDefinition | undefined { return this.#tools.get(name); }
  resolve(name: string): ToolDefinition | undefined {
    const normalized = normalizeName(name);
    return [...this.#tools.values()].find(t => [t.name, ...(t.aliases ?? [])].some(x => normalizeName(x) === normalized));
  }
  list(): ToolDefinition[] { return [...this.#tools.values()]; }
}

const normalizeName = (name: string): string => name.trim().toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Invokes a tool with schema validation on both sides and a hard deadline. Tool
 * output must be a well-formed guarded value; anything else fails closed.
 */
export async function invokeTool(tool: ToolDefinition, args: Record<string, GuardedValue>, context: ToolContext, deadline: number, onInvoked?: () => void): Promise<GuardedValue> {
  const plain = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v.value]));
  const schemaErrors = validateSchema(plain, tool.inputSchema);
  if (schemaErrors.length) throw new ProtocolError(`TOOL_SCHEMA_INVALID:${schemaErrors.join(";")}`);
  // Mark entry before calling so synchronous execution failures still count.
  onInvoked?.();
  const operation = context.simulate && tool.simulate ? tool.simulate(args, context) : tool.execute(args, context);
  const output = await beforeDeadline(operation, deadline);
  const outputErrors = validateGuardedValue(output);
  if (outputErrors.length) throw new ProtocolError(`TOOL_OUTPUT_INVALID:${outputErrors.join(";")}`);
  const outputSchemaErrors = validateSchema(output.value, tool.outputSchema);
  if (outputSchemaErrors.length) throw new ProtocolError(`TOOL_OUTPUT_SCHEMA_INVALID:${outputSchemaErrors.join(";")}`);
  return output;
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new ProtocolError("WORKFLOW_TIMEOUT");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProtocolError("WORKFLOW_TIMEOUT")), remaining); })]);
  } finally { if (timer) clearTimeout(timer); }
}
