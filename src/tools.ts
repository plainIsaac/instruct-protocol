import type { Effect, GuardedValue, JsonSchema } from "./types.js";

export interface ToolContext { signal?: AbortSignal; simulate: boolean; variables: Readonly<Record<string, GuardedValue>> }
export interface ToolDefinition {
  name: string; aliases?: string[]; capability: string; effects: Effect[];
  inputSchema?: JsonSchema; outputSchema?: JsonSchema;
  execute(args: Record<string, GuardedValue>, context: ToolContext): Promise<GuardedValue>;
  simulate?(args: Record<string, GuardedValue>, context: ToolContext): Promise<GuardedValue>;
  compensate?(value: GuardedValue, context: ToolContext): Promise<void>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): this { if (this.#tools.has(tool.name)) throw new Error(`DUPLICATE_TOOL:${tool.name}`); this.#tools.set(tool.name, tool); return this; }
  get(name: string): ToolDefinition | undefined { return this.#tools.get(name); }
  resolve(name: string): ToolDefinition | undefined {
    const normalized = name.trim().toLowerCase().replace(/[\s_-]+/g, "");
    return [...this.#tools.values()].find(t => [t.name, ...(t.aliases ?? [])].some(x => x.toLowerCase().replace(/[\s_-]+/g, "") === normalized));
  }
  list(): ToolDefinition[] { return [...this.#tools.values()]; }
}
