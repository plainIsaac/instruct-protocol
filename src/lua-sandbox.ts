import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { ProtocolError, errorCode } from "./errors.js";
import type { JsonValue } from "./types.js";

export interface LuaSandboxRequest {
  source: string;
  inputs: Record<string, JsonValue>;
  maxInstructions: number;
  maxMemoryBytes: number;
  maxDurationMs: number;
  signal?: AbortSignal;
  /** Host-mediated tool call. Rejections must be ProtocolErrors; other errors become TOOL_FAILED. */
  callTool(name: string, args: unknown): Promise<JsonValue>;
  /** Called when the VM is ready; the program's time budget starts here. */
  onReady?(): void;
}

export interface LuaSandboxResult { value: JsonValue }

// Codes the sandbox itself produces. A program can raise any string, so anything
// else is accepted only if the host sent that exact code into this run.
const SANDBOX_CODES = new Set(["INSTRUCTION_BUDGET_EXCEEDED", "MEMORY_BUDGET_EXCEEDED", "OUTPUT_NOT_SERIALIZABLE", "OUTPUT_TOO_DEEP", "ARGUMENT_NOT_SERIALIZABLE", "GC_METAMETHOD_DENIED", "LUA_RUNTIME_ERROR"]);

const SANDBOX_STARTUP_TIMEOUT_MS = 5_000;
const wasmoonPath = createRequire(import.meta.url).resolve("wasmoon");

/**
 * Lua prelude, run in the same coroutine as the program. Count hooks are
 * per-coroutine, so installing the hook in a separate chunk would leave the program
 * unmetered. Once the budget is exhausted the hook fires on every instruction, so
 * `pcall` cannot absorb the error and keep running. Lua disables hooks while `__gc`
 * finalizers run, so finalizers are refused. Locals live in a `do` block so the
 * program cannot reset the counter.
 */
const PRELUDE = `do
  local sethook, error, rawget, setmt, limit = debug.sethook, error, rawget, setmetatable, __limit
  local count = 0
  local function tick()
    count = count + 1000
    if count > limit then sethook(tick, "", 1) error("INSTRUCTION_BUDGET_EXCEEDED", 0) end
  end
  sethook(tick, "", 1000)
  local inputs, call = __inputs, __tool
  instruct = { inputs = inputs, tool = function(name, args) return call(name, args):await() end }
  -- Lua marks an object for finalization only if __gc is present when the metatable is set.
  setmetatable = function(t, mt)
    if type(mt) == "table" and rawget(mt, "__gc") ~= nil then error("GC_METAMETHOD_DENIED", 0) end
    return setmt(t, mt)
  end
end
__inputs = nil; __tool = nil; __limit = nil
io = nil; os = nil; package = nil; require = nil; dofile = nil; loadfile = nil; load = nil
debug = nil; collectgarbage = nil; coroutine = nil; print = nil
string.dump = nil; math.random = nil; math.randomseed = nil
`;

// Runs as an eval'd CommonJS worker so the same code works from src/ and dist/.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { LuaFactory } = require(workerData.wasmoonPath);
const pending = new Map(); let nextId = 0;
parentPort.on("message", message => {
  const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
  // Reject with the bare code so Lua sees a string it can inspect with pcall.
  message.ok ? call.resolve(message.value) : call.reject(message.code);
});
function plain(value, depth) {
  if (depth > 64) throw new Error("OUTPUT_TOO_DEEP");
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("OUTPUT_NOT_SERIALIZABLE"); return value; }
  if (Array.isArray(value)) return value.map(item => plain(item, depth + 1));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {}; for (const key of Object.keys(value)) out[key] = plain(value[key], depth + 1); return out;
  }
  throw new Error("OUTPUT_NOT_SERIALIZABLE");
}
function code(error) {
  // Lua errors cross the wasm boundary as objects that are not instanceof Error,
  // and wasmoon may append a traceback. The host decides which codes are trusted.
  const raw = typeof error === "string" ? error : error && typeof error.message === "string" ? error.message : "";
  if (/not enough memory/.test(raw)) return "MEMORY_BUDGET_EXCEEDED";
  return (raw.replace(/^Error: /, "").match(/^[A-Z][A-Z0-9_]{0,79}/) || ["LUA_RUNTIME_ERROR"])[0];
}
(async () => {
  // Proxies would hand Lua live JS objects (and, through them, JS functions); host values are copied into plain tables instead.
  const lua = await new LuaFactory().createEngine({ traceAllocations: true, enableProxy: false });
  try {
    lua.global.set("__inputs", workerData.inputs);
    lua.global.set("__limit", workerData.maxInstructions);
    lua.global.set("__tool", (name, args) => {
      let safeArgs; try { safeArgs = plain(args, 0); } catch { return Promise.reject(new Error("ARGUMENT_NOT_SERIALIZABLE")); }
      return new Promise((resolve, reject) => {
        const id = ++nextId; pending.set(id, { resolve, reject });
        parentPort.postMessage({ type: "tool", id, name: String(name), args: safeArgs });
      });
    });
    lua.global.setMemoryMax(workerData.maxMemoryBytes);
    parentPort.postMessage({ type: "ready" });
    const result = await lua.doString(workerData.prelude + "\\n" + workerData.source + "\\nreturn main(instruct)");
    parentPort.postMessage({ type: "result", value: plain(result, 0) });
  } catch (error) {
    parentPort.postMessage({ type: "error", code: code(error) });
  } finally { lua.global.close(); }
})();
`;

/**
 * Executes Lua in a dedicated worker thread. The worker is terminated at the
 * deadline or on cancellation, which also stops runaway C-level library calls that
 * no Lua hook can interrupt.
 */
export function runLuaSandbox(request: LuaSandboxRequest): Promise<LuaSandboxResult> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) { reject(new ProtocolError("EXECUTION_ABORTED")); return; }
    const worker = new Worker(WORKER, {
      eval: true, stdout: true, stderr: true,
      workerData: { wasmoonPath, prelude: PRELUDE, source: request.source, inputs: request.inputs, maxInstructions: request.maxInstructions, maxMemoryBytes: request.maxMemoryBytes }
    });
    // Worker output is a disclosure surface; drain it without forwarding.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false; const sentCodes = new Set<string>();
    const finish = (settle: () => void) => {
      if (settled) return; settled = true;
      clearTimeout(timer); request.signal?.removeEventListener("abort", abort);
      void worker.terminate(); settle();
    };
    const abort = () => finish(() => reject(new ProtocolError("EXECUTION_ABORTED")));
    // Startup is host work, so the program's time budget starts once the VM is ready.
    let timer = setTimeout(() => finish(() => reject(new ProtocolError("SANDBOX_STARTUP_TIMEOUT"))), SANDBOX_STARTUP_TIMEOUT_MS);
    request.signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: { type: string; id?: number; name?: string; args?: unknown; value?: JsonValue; code?: string }) => {
      if (message.type === "ready") {
        request.onReady?.(); clearTimeout(timer); timer = setTimeout(() => finish(() => reject(new ProtocolError("PROGRAM_TIMEOUT"))), request.maxDurationMs);
      } else if (message.type === "tool") {
        // A request queued before termination must not start a tool after the run settled.
        if (settled) return;
        request.callTool(message.name!, message.args).then(
          value => { if (!settled) worker.postMessage({ id: message.id, ok: true, value }); },
          error => { const code = errorCode(error, "TOOL_FAILED"); sentCodes.add(code); if (!settled) worker.postMessage({ id: message.id, ok: false, code }); }
        );
      } else if (message.type === "result") finish(() => resolve({ value: message.value ?? null }));
      else if (message.type === "error") {
        const code = message.code && (SANDBOX_CODES.has(message.code) || sentCodes.has(message.code)) ? message.code : "LUA_RUNTIME_ERROR";
        finish(() => reject(new ProtocolError(code)));
      }
    });
    worker.on("error", () => finish(() => reject(new ProtocolError("SANDBOX_FAILED"))));
    worker.on("exit", () => finish(() => reject(new ProtocolError("SANDBOX_FAILED"))));
  });
}
