import { describe, expect, it } from "vitest";
import { analyzeProgram, executeProgram } from "../src/program.js";
import { defaultGuard, guarded } from "../src/guarded.js";
import type { Grant } from "../src/types.js";
import { ToolRegistry } from "../src/tools.js";

const grant: Grant = {
  capabilities: ["code:execute"], effects: [], disclosureDestinations: ["local"],
  budget: { maxDurationMs: 1000, maxInstructions: 100000, maxMemoryBytes: 4000000, maxOutputBytes: 1000, maxToolCalls: 4, maxCallDepth: 4 }
};
const analyze = (source: string) => analyzeProgram({ language: "lua", source }, grant);

describe("token-aware Lua advisory analysis", () => {
  it.each([
    "function main(ctx) return ctx.inputs.os end",
    "return { io = 1, os = 2, debug = 3, value = ctx.inputs.require }",
    "return 'choose os'",
    'return "io os debug while repeat goto require string.dump"',
    String.raw`return 'escaped \' os'`,
    String.raw`return "escaped \\" .. 'choose os'`,
    "-- os.execute('x') while true do end\nreturn 1",
    "--[==[ require('io') while true do end ]==]\nreturn 1",
    "return [=[os.execute('x') while true do end https://example.test]=]",
    "return { '/ordinary/path', 'https://example.test', 'file:data', '\\\\server' }"
  ])("accepts data, comments, and field names: %s", source => {
    expect(analyze(source)).toMatchObject({ valid: true, issues: [] });
  });

  it.each([
    "return io.open('x')", "os -- gap\n . execute('x')", "return debug.traceback()",
    "return require('x')", "return dofile('x')", "return loadfile('x')", "return load('x')",
    "return package.path", "collectgarbage()", "return string --[[]]\n . dump(f)",
    "return string['dump'](f)", "return _G['os']", "return _ENV --[[]]\n . debug",
    "local x = 1; os = {}"
  ])("rejects actual forbidden facilities: %s", source => {
    expect(analyze(source).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FORBIDDEN_API" })]));
  });

  it.each(["while true do end", "repeat f() until false", "goto again"])("preserves control-flow diagnostics: %s", source => {
    expect(analyze(source).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNBOUNDED_CONTROL_FLOW" })]));
  });

  it.each([
    "instruct.tool('vault', {})", "instruct --[=[gap]=]\n . tool -- gap\n ('vault', {})",
    "instruct['tool']('vault', {})", "instruct.tool([=[vault]=], {})",
    String.raw`instruct.tool('va\117lt', {})`, String.raw`instruct.tool('va\x75lt', {})`,
    String.raw`instruct.tool('va\u{75}lt', {})`, "instruct.tool('va\\z \n ult', {})"
  ])("checks the complete literal tool name: %s", source => {
    const tools = new ToolRegistry().register({ name: "vault", capability: "vault:read", effects: [], async execute() { throw new Error("unused"); } });
    expect(analyzeProgram({ language: "lua", source }, grant, tools).issues).toContainEqual({ severity: "error", code: "CAPABILITY_DENIED", message: "vault:read" });
    expect(analyzeProgram({ language: "lua", source }, { ...grant, capabilities: ["code:execute", "vault:read"] }, tools).valid).toBe(true);
  });

  it("preserves unknown-tool and no-registry capability checks", () => {
    expect(analyzeProgram({ language: "lua", source: "instruct.tool('missing', {})" }, grant, new ToolRegistry()).issues.map(i => i.code)).toContain("UNKNOWN_TOOL");
    expect(analyze("instruct.tool('vault', {})").issues).toContainEqual({ severity: "error", code: "CAPABILITY_DENIED", message: "tool:vault" });
  });

  it.each([
    "return \"instruct.tool('missing', {})\"", "-- instruct.tool('missing', {})\nreturn 1",
    "return [==[instruct.tool('missing', {})]==]", "ctx.inputs.instruct.tool('missing', {})",
    "instruct.tool(name, {})", "instruct.tool('prefix' .. name, {})", "instruct.tool(('vault'), {})"
  ])("leaves data and dynamic tool calls to runtime: %s", source => {
    expect(analyze(source).valid).toBe(true);
  });

  it.each([
    "for i = 1, 100002 do end", "for i = 200000, 1, -1 do end",
    "for -- gap\n i = -1, --[[]] 200000 do end", "for i = 1, 1e9 do end",
    "for i = 0, 0x20000 do end", "for i = 0, 1000, .001 do end"
  ])("rejects statically oversized numeric loops: %s", source => {
    expect(analyze(source).issues.map(i => i.code)).toContain("LOOP_LIMIT_EXCEEDED");
  });

  it.each([
    "for i = 1, 100000 do end", "for i = 1, 1000000, 1000 do end",
    "for i = 1000000, 1 do end", "for i = 1, 1000000 / 1000000 do end",
    "for i = 1, n do end", "return 'for i = 1, 999999999 do end'",
    "-- for i = 1, 999999999 do end\nreturn 1"
  ])("does not infer loop counts from partial expressions or data: %s", source => {
    expect(analyze(source).valid).toBe(true);
  });

  it("normalizes the initial newline of long literals and escaped physical newlines", () => {
    for (const source of ["instruct.tool([=[\r\nvault]=], {})", "instruct.tool('va\\\r\nult', {})"]) {
      expect(analyze(source).issues).toContainEqual({ severity: "error", code: "CAPABILITY_DENIED", message: source.includes("[=[") ? "tool:vault" : "tool:va\nult" });
    }
  });

  it.each([
    "--[=[ os while", "--[==[ ]=] os while", "return [=[ os while", "return 'os\\",
    "--[= not a long comment\ros.execute()", "-- comment\ros.execute()",
    "--[=[hidden]=]os.execute()", "--[[ hidden ]]os.execute()"
  ])("terminates on malformed/comment edges: %s", source => {
    expect(() => analyze(source)).not.toThrow();
    expect(analyze(source).issues.some(i => i.code === "FORBIDDEN_API")).toBe(source.endsWith("os.execute()"));
  });

  it.each([String.raw`instruct.tool('\q', {})`, String.raw`instruct.tool('\u{ffffffff}', {})`, "instruct.tool('unterminated"])("does not invent a static name from malformed literals: %s", source => {
    expect(analyze(source).valid).toBe(true);
  });

  it("bounds large source scanning with a non-denying diagnostic", () => {
    const report = analyze(" ".repeat(2000000) + "return 1");
    expect(report.valid).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({ severity: "warning", code: "LUA_ANALYSIS_LIMIT_REACHED" }));
  });

  it("bounds token and diagnostic storage", () => {
    const report = analyze("os;".repeat(200000));
    expect(report.valid).toBe(false);
    expect(report.issues.length).toBeLessThanOrEqual(101);
    expect(report.issues.map(i => i.code)).toContain("LUA_ANALYSIS_LIMIT_REACHED");
  });

  it("handles long delimiters and malformed unicode escapes without runaway rescanning", () => {
    const started = performance.now();
    for (const source of ["return [" + "=".repeat(100000) + "[os", "return '" + String.raw`\u{`.repeat(50000), "--" + "[=".repeat(100000)]) {
      expect(() => analyze(source)).not.toThrow();
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("executes ordinary field/path/string data through the real sandbox", async () => {
    const value = await executeProgram({ language: "lua", source: `
      -- os.execute() while repeat require
      function main(ctx)
        local result = { os = ctx.inputs.os, debug = 'choose os', io = [=[https://example.test/path]=] }
        return result
      end
    ` }, { inputs: { os: guarded("linux", defaultGuard("fixture")) }, grant });
    expect(value.value).toEqual({ os: "linux", debug: "choose os", io: "https://example.test/path" });
  });
});
