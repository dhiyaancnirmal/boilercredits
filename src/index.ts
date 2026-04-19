import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext } from "./types";
import meta from "./routes/meta";
import search from "./routes/search";
import { createRequestId, log } from "./lib/logger";
import { materializeRefreshJob, refreshDueJobs, seedWarmMaterializations } from "./lib/refresh";
import type { RefreshJob } from "./types";

const ALLOWED_ORIGINS = [
  "https://transfer-credits-purdue.pages.dev",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];
const LOCAL_FRONTEND_URL = "http://localhost:5174/";
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function getAllowedOrigins(env: AppContext["Bindings"]): string[] {
  const configuredOrigins = env.ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configuredOrigins?.length ? configuredOrigins : ALLOWED_ORIGINS;
}

const app = new Hono<AppContext>();

app.use("*", async (c, next) => {
  const requestId = createRequestId();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
});

app.use("/", async (c, next) => {
  if (c.req.path === "/" && c.env.ENVIRONMENT !== "production") {
    return c.text(`BoilerCredits API server. Open ${LOCAL_FRONTEND_URL} for the frontend.`);
  }

  await next();
});

app.use("/api/*", async (c, next) => {
  const allowedOrigins = getAllowedOrigins(c.env);

  const corsMiddleware = cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  });

  return corsMiddleware(c, next);
});

app.use("*", async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(name, value);
  }
});

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.route("/api/meta", meta);
app.route("/api/equivalency", search);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  const requestId = c.get("requestId");
  log(requestId, "error", "Unhandled application error", {
    error: err.message,
    path: c.req.path,
    method: c.req.method,
  });

  return c.json({ error: "Internal server error", requestId }, 500);
});

const worker = {
  fetch: (request: Request, env: AppContext["Bindings"], ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  async queue(batch: MessageBatch<RefreshJob>, env: AppContext["Bindings"], _ctx: ExecutionContext) {
    for (const message of batch.messages) {
      try {
        await materializeRefreshJob(env, message.body);
        message.ack();
      } catch (error) {
        console.error("Refresh job failed", error);
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: AppContext["Bindings"], _ctx: ExecutionContext) {
    await seedWarmMaterializations(env);
    await refreshDueJobs(env);
  },
};

export default worker;
