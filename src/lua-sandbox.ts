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
  /** Absolute host deadline, including VM startup. */
  deadline?: number;
  signal?: AbortSignal;
  /** Host-mediated tool call. Rejections must be ProtocolErrors; other errors become TOOL_FAILED. */
  callTool(name: string, args: unknown): Promise<JsonValue>;
  /** Called when the VM is ready; does not reset the deadline. */
  onReady?(): void;
  /** Host-local conservative consumption, including sub-hook instructions. */
  onInstructions?(used: number): void;
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
  local min = math.min
  local count, stride, report = 0, min(100, limit), __meter
  local function tick()
    count = count + stride
    if count >= limit then report(limit) sethook(tick, "", 1) error("INSTRUCTION_BUDGET_EXCEEDED", 0) end
    if limit - count < stride then stride = 1 sethook(tick, "", 1) end
    report(min(limit, count + stride - 1))
  end
  sethook(tick, "", stride)
  local inputs, call = __inputs, __tool
  instruct = { inputs = inputs, tool = function(name, args) return call(name, args):await() end }
  -- Lua marks an object for finalization only if __gc is present when the metatable is set.
  setmetatable = function(t, mt)
    if type(mt) == "table" and rawget(mt, "__gc") ~= nil then error("GC_METAMETHOD_DENIED", 0) end
    return setmt(t, mt)
  end
end
__inputs = nil; __tool = nil; __limit = nil; __meter = nil
io = nil; os = nil; package = nil; require = nil; dofile = nil; loadfile = nil; load = nil
debug = nil; collectgarbage = nil; coroutine = nil; print = nil
string.dump = nil; math.random = nil; math.randomseed = nil
`;

// Runs as an eval'd CommonJS worker so the same code works from src/ and dist/.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { LuaFactory } = require(workerData.wasmoonPath);
const pending = new Map(); let nextId = 0;
let instructions = Math.min(100, workerData.maxInstructions) - 1;
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
    lua.global.set("__meter", count => { instructions = count; });
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
    parentPort.postMessage({ type: "result", value: plain(result, 0), instructions });
  } catch (error) {
    parentPort.postMessage({ type: "error", code: code(error), instructions });
  } finally { lua.global.close(); }
})();
`;

/**
 * Executes Lua in a dedicated worker thread. The worker is terminated at the
 * deadline or on cancellation, which also stops runaway C-level library calls that
 * no Lua hook can interrupt.
 */
export function runLuaSandbox(request: LuaSandboxRequest): Promise<LuaSandboxResult> {
  const deadline = Math.min(request.deadline ?? Infinity, performance.now() + request.maxDurationMs);
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) { reject(new ProtocolError("EXECUTION_ABORTED")); return; }
    if (performance.now() >= deadline) { reject(new ProtocolError("PROGRAM_TIMEOUT")); return; }
    const worker = new Worker(WORKER, {
      eval: true, stdout: true, stderr: true,
      workerData: { wasmoonPath, prelude: PRELUDE, source: request.source, inputs: request.inputs, maxInstructions: request.maxInstructions, maxMemoryBytes: request.maxMemoryBytes }
    });
    // Worker output is a disclosure surface; drain it without forwarding.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false; const sentCodes = new Set<string>();
    const finish = (settle: () => void, instructions = request.maxInstructions) => {
      if (settled) return; settled = true;
      request.onInstructions?.(instructions);
      clearTimeout(timer); request.signal?.removeEventListener("abort", abort);
      // Serialize VM lifetimes, not merely result delivery, for the peak-live limit.
      void worker.terminate().then(settle, settle);
    };
    const abort = () => finish(() => reject(new ProtocolError("EXECUTION_ABORTED")));
    // Startup and execution use one clock. A separate host startup cap can only shorten it.
    let timer = setTimeout(() => finish(() => reject(new ProtocolError(deadline - performance.now() <= 0 ? "PROGRAM_TIMEOUT" : "SANDBOX_STARTUP_TIMEOUT"))), Math.min(SANDBOX_STARTUP_TIMEOUT_MS, Math.max(1, deadline - performance.now())));
    request.signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: { type: string; id?: number; name?: string; args?: unknown; value?: JsonValue; code?: string; instructions?: number }) => {
      if (settled) return;
      if (request.signal?.aborted) { abort(); return; }
      if (performance.now() >= deadline) { finish(() => reject(new ProtocolError("PROGRAM_TIMEOUT"))); return; }
      if (message.type === "ready") {
        request.onReady?.(); clearTimeout(timer); timer = setTimeout(() => finish(() => reject(new ProtocolError("PROGRAM_TIMEOUT"))), Math.max(1, deadline - performance.now()));
      } else if (message.type === "tool") {
        // A request queued before termination must not start a tool after the run settled.
        if (settled) return;
        request.callTool(message.name!, message.args).then(
          value => { if (!settled) worker.postMessage({ id: message.id, ok: true, value }); },
          error => { const code = errorCode(error, "TOOL_FAILED"); sentCodes.add(code); if (!settled) worker.postMessage({ id: message.id, ok: false, code }); }
        );
      } else if (message.type === "result") finish(() => resolve({ value: message.value ?? null }), message.instructions);
      else if (message.type === "error") {
        const code = message.code && (SANDBOX_CODES.has(message.code) || sentCodes.has(message.code)) ? message.code : "LUA_RUNTIME_ERROR";
        finish(() => reject(new ProtocolError(code)), message.instructions);
      }
    });
    worker.on("error", () => finish(() => reject(new ProtocolError("SANDBOX_FAILED"))));
    worker.on("exit", () => finish(() => reject(new ProtocolError("SANDBOX_FAILED"))));
  });
}
