import type { Effect, GuardedValue, JsonSchema } from "./types.js";

export interface ToolContext { signal?: AbortSignal; simulate: boolean; variables: Readonly<Record<string, GuardedValue>> }
export interface ToolDefinition {
  name: string; aliases?: string[]; capability: string; effects: Effect[];
  isolation?: "in-process" | "process";
  inputSchema?: JsonSchema; outputSchema?: JsonSchema;
  execute(args: Record<string, GuardedValue>, context: ToolContext): Promise<GuardedValue>;
  simulate?(args: Record<string, GuardedValue>, context: ToolContext): Promise<GuardedValue>;
  compensate?(value: GuardedValue, context: ToolContext): Promise<void>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): this {
    if (!tool || !/^[a-zA-Z][\w.-]{0,127}$/.test(tool.name) || !tool.capability || !Array.isArray(tool.effects) || typeof tool.execute !== "function") throw new Error("INVALID_TOOL_DEFINITION");
    if (this.#tools.has(tool.name)) throw new Error(`DUPLICATE_TOOL:${tool.name}`);
    const names = [tool.name, ...(tool.aliases ?? [])].map(normalizeName);
    for (const existing of this.#tools.values()) if ([existing.name, ...(existing.aliases ?? [])].map(normalizeName).some(name => names.includes(name))) throw new Error(`AMBIGUOUS_TOOL_NAME:${tool.name}`);
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
