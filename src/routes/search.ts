import { Hono } from "hono";
import type { AppContext, EquivalencySearchResult } from "../types";
import {
  fetchEquivalencyReport,
  fetchPurdueEquivalencyReport,
  PurdueTimeoutError,
  PurdueUpstreamError,
} from "../services/purdue-client";
import { parseEquivalencyReport } from "../services/purdue-parser";
import { getCached, setCache, makeCacheKey } from "../lib/cache";
import { checkRateLimit, rateLimitHeaders } from "../lib/rate-limit";
import { searchBodySchema, purdueSearchBodySchema } from "../lib/validators";
import { log } from "../lib/logger";

const search = new Hono<AppContext>();

function upstreamErrorResponse(error: unknown): { message: string; status: 502 | 504 } {
  if (error instanceof PurdueTimeoutError) {
    return { message: error.message, status: 504 };
  }
  if (error instanceof PurdueUpstreamError) {
    return { message: error.message, status: 502 };
  }
  return {
    message: error instanceof Error ? error.message : "Unknown upstream error",
    status: 502,
  };
}

search.post("/search", async (c) => {
  const rl = await checkRateLimit(c.req.raw, c.env.CACHE, "search");
  if (!rl.allowed) {
    return c.json({ error: "Rate limit exceeded" }, 429, rateLimitHeaders(rl.remaining, rl.resetAt));
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = searchBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.issues }, 400);

  const { rows } = parsed.data;
  const cacheKey = makeCacheKey("search", JSON.stringify(rows));
  const cached = await getCached<EquivalencySearchResult>(c.env.CACHE, c.env.DB, cacheKey);
  if (cached) return c.json(cached, 200, rateLimitHeaders(rl.remaining, rl.resetAt));

  try {
    const html = await fetchEquivalencyReport(rows);
    const result: EquivalencySearchResult = {
      rows: parseEquivalencyReport(html),
      query: rows[0],
    };

    await setCache(c.env.CACHE, c.env.DB, cacheKey, result, 600);
    return c.json(result, 200, rateLimitHeaders(rl.remaining, rl.resetAt));
  } catch (error) {
    const requestId = c.get("requestId");
    const upstream = upstreamErrorResponse(error);
    log(requestId, "error", "Forward search failed", {
      error: upstream.message,
      rowCount: rows.length,
    });
    return c.json({ error: upstream.message, requestId }, upstream.status);
  }
});

search.post("/reverse", async (c) => {
  const rl = await checkRateLimit(c.req.raw, c.env.CACHE, "search");
  if (!rl.allowed) {
    return c.json({ error: "Rate limit exceeded" }, 429, rateLimitHeaders(rl.remaining, rl.resetAt));
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = purdueSearchBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.issues }, 400);

  const { rows } = parsed.data;
  const cacheKey = makeCacheKey("reverse-search", JSON.stringify(rows));
  const cached = await getCached<EquivalencySearchResult>(c.env.CACHE, c.env.DB, cacheKey);
  if (cached) return c.json(cached, 200, rateLimitHeaders(rl.remaining, rl.resetAt));

  try {
    const html = await fetchPurdueEquivalencyReport(rows);
    const result: EquivalencySearchResult = {
      rows: parseEquivalencyReport(html),
      query: {
        location: rows[0].location,
        state: rows[0].state,
        school: rows[0].school,
        subject: rows[0].subject,
        course: rows[0].course,
      },
    };

    await setCache(c.env.CACHE, c.env.DB, cacheKey, result, 600);
    return c.json(result, 200, rateLimitHeaders(rl.remaining, rl.resetAt));
  } catch (error) {
    const requestId = c.get("requestId");
    const upstream = upstreamErrorResponse(error);
    log(requestId, "error", "Reverse search failed", {
      error: upstream.message,
      rowCount: rows.length,
    });
    return c.json({ error: upstream.message, requestId }, upstream.status);
  }
});

export default search;
