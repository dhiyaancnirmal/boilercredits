/** Generates a short unique request ID for tracing. */
export function createRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export type LogLevel = "info" | "warn" | "error";

/**
 * Structured logger that prefixes every message with the request ID.
 * Keeps things simple for Cloudflare Workers (console.log → Workers Logs).
 */
export function log(
  requestId: string,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
): void {
  const entry = {
    requestId,
    level,
    message,
    ts: new Date().toISOString(),
    ...extra,
  };

  switch (level) {
    case "error":
      console.error(JSON.stringify(entry));
      break;
    case "warn":
      console.warn(JSON.stringify(entry));
      break;
    default:
      console.log(JSON.stringify(entry));
  }
}
