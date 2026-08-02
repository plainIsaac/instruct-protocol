import type { ExecutionEvent, ExecutionMetrics, JsonValue } from "./types.js";

export interface ProtocolObserver { emit(event: ExecutionEvent): void }
export interface LogWriter { write(line: string): void }
export interface SecurityAlert { code: string; event: ExecutionEvent }
export interface AlertSink { alert(value: SecurityAlert): void }

export const emptyMetrics = (): ExecutionMetrics => ({
  totalDurationMs: 0, normalizationDurationMs: 0, analysisDurationMs: 0, executionDurationMs: 0, receiptDurationMs: 0,
  nodeCount: 0, toolCalls: 0, codeExecutions: 0, retries: 0, recoveries: 0, failures: 0, peakCallDepth: 0
});

export class BufferedObserver implements ProtocolObserver {
  readonly events: ExecutionEvent[] = [];
  emit(event: ExecutionEvent): void { this.events.push(structuredClone(event)); }
}

export class CompositeObserver implements ProtocolObserver {
  constructor(private readonly observers: ProtocolObserver[]) {}
  emit(event: ExecutionEvent): void { for (const observer of this.observers) observer.emit(event); }
}

export class JsonLogObserver implements ProtocolObserver {
  constructor(private readonly writer: LogWriter = { write: line => process.stderr.write(`${line}\n`) }) {}
  emit(event: ExecutionEvent): void { this.writer.write(JSON.stringify(sanitizeLogValue(event))); }
}

/** Sanitized audit stream with explicit operational alerts for security-relevant outcomes. */
export class SecurityAuditObserver implements ProtocolObserver {
  constructor(private readonly writer: LogWriter, private readonly alerts: AlertSink) {}
  emit(event: ExecutionEvent): void {
    const sanitized = sanitizeLogValue(event) as unknown as ExecutionEvent;
    this.writer.write(JSON.stringify(sanitized));
    const code = securityAlertCode(sanitized);
    if (code) this.alerts.alert({ code, event: structuredClone(sanitized) });
  }
}

export class EventRecorder {
  readonly events: ExecutionEvent[] = [];
  readonly startedAt = performance.now();
  #sequence = 0;
  constructor(private readonly observer?: ProtocolObserver) {}
  emit(type: string, nodeId?: string, detail: Record<string, JsonValue> = {}, durationMs?: number): ExecutionEvent {
    const event: ExecutionEvent = {
      sequence: ++this.#sequence, type, timestamp: new Date().toISOString(), elapsedMs: round(performance.now() - this.startedAt),
      durationMs: durationMs === undefined ? undefined : round(durationMs), nodeId, detail: sanitizeDetail(detail)
    };
    this.events.push(event); this.observer?.emit(event); return event;
  }
}

const sensitiveKeys = /^(?:value|payload|content|secret|token|password|authorization|arguments?|inputs?|outputs?|from|to)$/i;
export function sanitizeDetail(detail: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, sensitiveKeys.test(key) ? "[REDACTED]" : sanitizeLogValue(value)])) as Record<string, JsonValue>;
}

export function sanitizeLogValue(value: unknown, depth = 0): JsonValue {
  if (depth > 6) return "[MAX_DEPTH]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 256 ? `${value.slice(0, 256)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeLogValue(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKeys.test(key) ? "[REDACTED]" : sanitizeLogValue(item, depth + 1)]));
  return String(value);
}

export function round(value: number): number { return Math.round(value * 1000) / 1000; }

function securityAlertCode(event: ExecutionEvent): string | undefined {
  if (event.type.endsWith(".denied")) return "EXECUTION_DENIED";
  if (event.type.endsWith(".failed")) return String(event.detail.code ?? "EXECUTION_FAILED").slice(0, 80);
  return undefined;
}
