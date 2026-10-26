import type { AnalysisReport, Grant } from "./types.js";
import type { ToolRegistry } from "./tools.js";

type Token = { kind: "name" | "number" | "string" | "symbol"; text: string };
const forbiddenGlobals = new Set(["require", "dofile", "loadfile", "load", "package", "io", "os", "debug", "collectgarbage"]);
const MAX_SOURCE_CHARS = 1000000;
const MAX_TOKENS = 100000;
const MAX_ISSUES = 100;
const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };

/** Advisory only: syntax, ambient authority, dynamic calls, and budgets remain VM/host responsibilities. */
export function analyzeLuaSource(source: string, grant: Grant, tools?: ToolRegistry): AnalysisReport["issues"] {
  const { tokens, limited } = tokenize(source);
  const issues: AnalysisReport["issues"] = [];
  const delimiters: string[] = [];
  for (let i = 0; i < tokens.length && issues.length < MAX_ISSUES; i++) {
    const token = tokens[i]!;
    if (token.kind === "symbol") {
      if (["{", "(", "["].includes(token.text)) delimiters.push(token.text);
      else if (["}", ")", "]"].includes(token.text)) delimiters.pop();
    }
    const previous = tokens[i - 1]?.text;
    const field = previous === "." || previous === ":" ||
      (delimiters.at(-1) === "{" && tokens[i + 1]?.text === "=" && (previous === "{" || previous === "," || previous === ";"));
    if (token.kind !== "name" || field) continue;
    const member = staticMember(tokens, i + 1);
    if (forbiddenGlobals.has(token.text) ||
      (token.text === "string" && member?.name === "dump") ||
      (["_G", "_ENV"].includes(token.text) && member && forbiddenGlobals.has(member.name))) {
      issues.push({ severity: "error", code: "FORBIDDEN_API", message: "Forbidden ambient API" });
    }
    if (["while", "repeat", "goto"].includes(token.text)) {
      issues.push({ severity: "error", code: "UNBOUNDED_CONTROL_FLOW", message: "Unbounded control flow" });
    }
    if (token.text === "for" && oversizedLoop(tokens, i)) {
      issues.push({ severity: "error", code: "LOOP_LIMIT_EXCEEDED", message: "Numeric loop exceeds 100000 iterations" });
    }
    if (token.text === "instruct" && member?.name === "tool" && tokens[member.next]?.text === "(") {
      const argument = tokens[member.next + 1];
      const after = tokens[member.next + 2]?.text;
      // Only a complete literal argument is static; concatenations/aliases stay runtime-authorized.
      if (argument?.kind === "string" && (after === "," || after === ")")) {
        const capability = tools ? tools.get(argument.text)?.capability : `tool:${argument.text}`;
        if (!capability) issues.push({ severity: "error", code: "UNKNOWN_TOOL", message: argument.text });
        else if (!grant.capabilities.includes(capability)) issues.push({ severity: "error", code: "CAPABILITY_DENIED", message: capability });
      }
    }
  }
  if (limited || issues.length >= MAX_ISSUES) issues.push({ severity: "warning", code: "LUA_ANALYSIS_LIMIT_REACHED", message: "Advisory analysis truncated; runtime authorization and metering still apply" });
  return issues;
}

function oversizedLoop(tokens: Token[], i: number): boolean {
  if (tokens[i + 1]?.kind !== "name" || tokens[i + 2]?.text !== "=") return false;
  const readNumber = (): number | undefined => {
    const negative = tokens[i]?.text === "-";
    if (negative) i++;
    const token = tokens[i++];
    if (token?.kind !== "number") return;
    const value = Number(token.text) * (negative ? -1 : 1);
    return Number.isFinite(value) ? value : undefined;
  };
  i += 3;
  const start = readNumber();
  if (tokens[i++]?.text !== ",") return false;
  const end = readNumber();
  let step: number | undefined = 1;
  if (tokens[i]?.text === ",") { i++; step = readNumber(); }
  // Do not mistake a prefix of a dynamic expression for a literal bound.
  if (tokens[i]?.text !== "do" || start === undefined || end === undefined || step === undefined || step === 0) return false;
  return (end - start) / step >= 100000;
}

function staticMember(tokens: Token[], i: number): { name: string; next: number } | undefined {
  if (tokens[i]?.text === "." && tokens[i + 1]?.kind === "name") return { name: tokens[i + 1]!.text, next: i + 2 };
  if (tokens[i]?.text === "[" && tokens[i + 1]?.kind === "string" && tokens[i + 2]?.text === "]") return { name: tokens[i + 1]!.text, next: i + 3 };
}

/** A forward-only lexer; literals stay opaque to checks on executable tokens. */
function tokenize(input: string): { tokens: Token[]; limited: boolean } {
  const source = input.slice(0, MAX_SOURCE_CHARS);
  const tokens: Token[] = [];
  const name = /[A-Za-z_][A-Za-z_0-9]*/y;
  const number = /(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
  let i = 0;
  const longBracket = (start: number): { content: string; end: number; closed: boolean } | undefined => {
    if (source[start] !== "[") return;
    let open = start + 1;
    while (source[open] === "=") open++;
    if (source[open] !== "[") return;
    const close = "]" + "=".repeat(open - start - 1) + "]";
    const end = source.indexOf(close, open + 1);
    const content = source.slice(open + 1, end < 0 ? source.length : end).replace(/\r\n|\n\r|\r/g, "\n").replace(/^\n/, "");
    return { content, end: end < 0 ? source.length : end + close.length, closed: end >= 0 };
  };
  while (i < source.length && tokens.length < MAX_TOKENS) {
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && source[i + 1] === "-") {
      const long = longBracket(i + 2);
      if (long) i = long.end;
      else { i += 2; while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++; }
      continue;
    }
    const long = c === "[" ? longBracket(i) : undefined;
    if (long) { tokens.push({ kind: long.closed ? "string" : "symbol", text: long.content }); i = long.end; continue; }
    if (c === "'" || c === '"') {
      const parts: string[] = [];
      let valid = true;
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] !== "\\") {
          if (source[i] === "\n" || source[i] === "\r") valid = false;
          parts.push(source[i++]!); continue;
        }
        i++;
        const escaped = source[i++];
        if (escaped === undefined) { valid = false; break; }
        if (escaped === "\r" || escaped === "\n") {
          if ((source[i] === "\r" || source[i] === "\n") && source[i] !== escaped) i++;
          parts.push("\n"); continue;
        }
        if (escaped === "z") { while (i < source.length && /\s/.test(source[i]!)) i++; continue; }
        if (/\d/.test(escaped)) {
          let digits = escaped;
          while (digits.length < 3 && i < source.length && /\d/.test(source[i]!)) digits += source[i++];
          if (Number(digits) > 255) valid = false;
          parts.push(String.fromCharCode(Number(digits))); continue;
        }
        if (escaped === "x" && /^[\da-fA-F]{2}$/.test(source.slice(i, i + 2))) {
          parts.push(String.fromCharCode(parseInt(source.slice(i, i + 2), 16))); i += 2; continue;
        }
        if (escaped === "u" && source[i] === "{") {
          // Fixed lookahead prevents repeated malformed escapes from rescanning the suffix.
          const match = /^\{([\da-fA-F]{1,8})\}/.exec(source.slice(i, i + 10));
          const value = match ? parseInt(match[1]!, 16) : NaN;
          if (value <= 0x10ffff) { parts.push(String.fromCodePoint(value)); i += match![0].length; continue; }
        }
        if (escapes[escaped] === undefined) valid = false;
        parts.push(escapes[escaped] ?? escaped);
      }
      if (i < source.length) i++; else valid = false;
      tokens.push({ kind: valid ? "string" : "symbol", text: parts.join("") });
      continue;
    }
    name.lastIndex = i;
    const identifier = name.exec(source);
    if (identifier) { tokens.push({ kind: name.lastIndex === source.length && input.length > source.length ? "symbol" : "name", text: identifier[0] }); i = name.lastIndex; continue; }
    number.lastIndex = i;
    const numeric = number.exec(source);
    if (numeric) { tokens.push({ kind: "number", text: numeric[0] }); i = number.lastIndex; continue; }
    tokens.push({ kind: "symbol", text: c }); i++;
  }
  return { tokens, limited: input.length > source.length || i < source.length };
}
