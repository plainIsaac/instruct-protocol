/**
 * An error raised by this library. Its message starts with a stable code, optionally
 * followed by `:detail`. Only the code may cross the trust boundary; the detail can
 * contain model-supplied names and stays local.
 */
export class ProtocolError extends Error {
  readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = message.split(":", 1)[0]!;
  }
}

/**
 * Returns a disclosure-safe code for an error. Messages from tools, resolvers, and
 * the Lua runtime are arbitrary text and may embed guarded values, so anything not
 * raised as a ProtocolError collapses to the caller's fallback code.
 */
export function errorCode(error: unknown, fallback: string): string {
  return error instanceof ProtocolError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : fallback;
}
