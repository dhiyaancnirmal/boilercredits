import { beforeEach, describe, expect, it } from "vitest";
import { __clearRateLimitForTests, checkRateLimit } from "../src/lib/rate-limit";

beforeEach(() => {
  __clearRateLimitForTests();
});

describe("rate limiting", () => {
  it("does not let a spoofed Origin header bypass rate limiting in production", async () => {
    const result = await checkRateLimit(
      new Request("https://boilercredits.xyz/api/meta/states", {
        headers: { origin: "http://localhost:5174", "CF-Connecting-IP": "203.0.113.8" },
      }),
      undefined,
      "meta"
    );

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(59);
  });

  it("bypasses rate limiting for requests to a localhost hostname", async () => {
    const result = await checkRateLimit(
      new Request("http://localhost:8787/api/meta/states"),
      undefined,
      "meta"
    );

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does not treat attacker-controlled localhost-like origins as local", async () => {
    const request = new Request("https://boilercredits.xyz/api/meta/states", {
      headers: {
        origin: "https://localhost.attacker.tld",
        "CF-Connecting-IP": "203.0.113.8",
      },
    });

    const result = await checkRateLimit(request, undefined, "meta");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(59);
  });
});
