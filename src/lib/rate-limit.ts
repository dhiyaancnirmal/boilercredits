interface InMemoryRateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const WINDOW_SECONDS = 60;
const DEFAULT_LIMIT = 60;
const NL_LIMIT = 10;
const MAX_IN_MEMORY_KEYS = 5000;
const inMemoryRateLimit = new Map<string, InMemoryRateLimitEntry>();

/** Clear module rate-limit state for tests. */
export function __clearRateLimitForTests(): void {
  inMemoryRateLimit.clear();
}

function getClientIP(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Real-IP") || "unknown";
}

function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function cleanupInMemoryRateLimit(now: number, windowMs: number): void {
  for (const [key, entry] of inMemoryRateLimit.entries()) {
    if (now - entry.windowStart > windowMs) {
      inMemoryRateLimit.delete(key);
    }
  }

  if (inMemoryRateLimit.size <= MAX_IN_MEMORY_KEYS) return;

  const entriesByAge = [...inMemoryRateLimit.entries()].sort(
    (a, b) => a[1].windowStart - b[1].windowStart
  );
  const overflow = inMemoryRateLimit.size - MAX_IN_MEMORY_KEYS;
  for (const [key] of entriesByAge.slice(0, overflow)) {
    inMemoryRateLimit.delete(key);
  }
}

export async function checkRateLimit(
  request: Request,
  kv: KVNamespace | undefined,
  endpoint: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  if (isLocalRequest(request)) {
    return {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      resetAt: Date.now() + WINDOW_SECONDS * 1000,
    };
  }

  const ip = getClientIP(request);
  const limit = endpoint === "nl" ? NL_LIMIT : DEFAULT_LIMIT;
  const key = `ratelimit:${ip}:${endpoint}`;
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;

  if (!kv) {
    cleanupInMemoryRateLimit(now, windowMs);

    const current = inMemoryRateLimit.get(key) ?? { count: 0, windowStart: now };
    const activeWindow = now - current.windowStart > windowMs ? { count: 0, windowStart: now } : current;

    if (activeWindow.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: activeWindow.windowStart + windowMs,
      };
    }

    activeWindow.count += 1;
    inMemoryRateLimit.set(key, activeWindow);

    return {
      allowed: true,
      remaining: limit - activeWindow.count,
      resetAt: activeWindow.windowStart + windowMs,
    };
  }

  const raw = await kv.get(key);
  let entry: RateLimitEntry = raw
    ? JSON.parse(raw)
    : { count: 0, windowStart: now };

  if (now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now };
  }

  if (entry.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.windowStart + windowMs,
    };
  }

  entry.count++;
  await kv.put(key, JSON.stringify(entry), { expirationTtl: WINDOW_SECONDS + 10 });

  return {
    allowed: true,
    remaining: limit - entry.count,
    resetAt: entry.windowStart + windowMs,
  };
}

export function rateLimitHeaders(remaining: number, resetAt: number): Record<string, string> {
  return {
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
  };
}
