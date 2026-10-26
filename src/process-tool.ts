import { ProtocolError } from "./errors.js";
import { spawn } from "node:child_process";
import type { GuardedValue } from "./types.js";
import type { ToolContext, ToolDefinition } from "./tools.js";

export interface ProcessToolOptions extends Omit<ToolDefinition, "execute" | "simulate" | "isolation"> {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  maxResponseBytes?: number;
}

/** JSON-over-stdio process boundary. OS policy and artifact attestation belong to the deployment. */
export function processTool(options: ProcessToolOptions): ToolDefinition {
  if (!options.command || !Number.isSafeInteger(options.maxResponseBytes ?? 1_000_000) || (options.maxResponseBytes ?? 1_000_000) <= 0) throw new ProtocolError("INVALID_PROCESS_TOOL_OPTIONS");
  return {
    name: options.name, aliases: options.aliases, capability: options.capability,
    operations: options.operations, outputTransform: options.outputTransform,
    effects: options.effects, idempotent: options.idempotent, inputSchema: options.inputSchema, outputSchema: options.outputSchema,
    isolation: "process", execute: (toolArgs, context) => invokeProcess(options, toolArgs, context)
  };
}

function invokeProcess(options: ProcessToolOptions, args: Record<string, GuardedValue>, context: ToolContext): Promise<GuardedValue> {
  return new Promise((resolve, reject) => {
    if (context.signal?.aborted) { reject(new ProtocolError("PROCESS_TOOL_ABORTED")); return; }
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd, env: options.env ?? {}, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const limit = options.maxResponseBytes ?? 1_000_000;
    const stdout: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0; let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; context.signal?.removeEventListener("abort", abort); callback(); };
    const abort = () => { child.kill("SIGKILL"); finish(() => reject(new ProtocolError("PROCESS_TOOL_ABORTED"))); };
    context.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", error => finish(() => reject(new ProtocolError(`PROCESS_TOOL_START_FAILED:${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`))));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > limit) { child.kill("SIGKILL"); finish(() => reject(new ProtocolError("PROCESS_TOOL_OUTPUT_EXCEEDED"))); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > limit) child.kill("SIGKILL"); });
    child.on("close", code => finish(() => {
      if (code !== 0) { reject(new ProtocolError(`PROCESS_TOOL_FAILED:${code ?? "SIGNAL"}`)); return; }
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as GuardedValue); }
      catch { reject(new ProtocolError("PROCESS_TOOL_INVALID_RESPONSE")); }
    }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ arguments: args, simulate: context.simulate }));
  });
}
