import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const environment = process.env;

describe("API route facade", () => {
  beforeEach(() => {
    process.env = {
      ...environment,
      APP_ENV: "test",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    };
    vi.resetModules();
  });

  it("accepts only the exact configured Origin and Host", async () => {
    const { assertTrustedRequestOrigin } = await import("../../src/lib/server/api-route");
    process.env.APP_ENV = "local";
    const trusted = new Request("http://127.0.0.1:3000/api/commands", {
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    });
    expect(() => assertTrustedRequestOrigin(trusted)).not.toThrow();

    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000.evil.example",
      "https://127.0.0.1:3000",
      "null",
    ]) {
      const hostile = new Request("http://127.0.0.1:3000/api/commands", {
        headers: { host: "127.0.0.1:3000", origin },
      });
      expect(() => assertTrustedRequestOrigin(hostile)).toThrow("origem");
    }

    const hostileRequestHost = new Request("http://127.0.0.1:3000/api/commands", {
      headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3000" },
    });
    expect(() => assertTrustedRequestOrigin(hostileRequestHost)).toThrow("origem");
  });

  it("requires proxy-authenticated host and protocol in production", async () => {
    const { assertTrustedRequestOrigin } = await import("../../src/lib/server/api-route");
    process.env.APP_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "https://set-livre.example";
    const trustedHeaders = {
      host: "set-livre.example",
      origin: "https://set-livre.example",
      "x-forwarded-host": "set-livre.example",
      "x-forwarded-proto": "https",
    };

    expect(() =>
      assertTrustedRequestOrigin(
        new Request("http://internal-node:3000/api/commands", { headers: trustedHeaders }),
      ),
    ).not.toThrow();
    for (const headers of [
      { ...trustedHeaders, "x-forwarded-host": "attacker.example" },
      { ...trustedHeaders, "x-forwarded-proto": "http" },
      { host: trustedHeaders.host, origin: trustedHeaders.origin },
    ]) {
      expect(() =>
        assertTrustedRequestOrigin(
          new Request("http://internal-node:3000/api/commands", { headers }),
        ),
      ).toThrow("origem");
    }
  });

  it("rejects a plaintext application origin outside the local runtime", async () => {
    const { assertTrustedRequestOrigin } = await import("../../src/lib/server/api-route");
    process.env.APP_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "http://set-livre.example";
    const request = new Request("http://set-livre.example/api/commands", {
      headers: { origin: "http://set-livre.example" },
    });

    expect(() => assertTrustedRequestOrigin(request)).toThrow("HTTPS");
  });

  it("limits the body while consuming the stream, independent of Content-Length", async () => {
    const { readLimitedJson } = await import("../../src/lib/server/api-route");
    const body = JSON.stringify({ oversized: "x".repeat(512) });
    const request = new Request("http://127.0.0.1:3000/api/commands", {
      body,
      headers: { "content-type": "application/json", "content-length": "10" },
      method: "POST",
    });
    await expect(readLimitedJson(request, 64)).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
      status: 413,
    });
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "application/json-patch+json"])(
    "rejects an unsupported content type: %s",
    async (contentType) => {
      const { readLimitedJson } = await import("../../src/lib/server/api-route");
      const request = new Request("http://127.0.0.1:3000/api/commands", {
        body: "{}",
        headers: { "content-type": contentType },
        method: "POST",
      });
      await expect(readLimitedJson(request)).rejects.toMatchObject({
        code: "CONTENT_TYPE_INVALID",
        status: 415,
      });
    },
  );

  it("never includes an unexpected exception in the public response", async () => {
    const { apiErrorResponse } = await import("../../src/lib/server/api-route");
    const response = apiErrorResponse(
      new Error("postgresql://admin:sensitive@remote.example/production"),
      "e65fe64c-3788-4cf0-beb3-c344025b0bb0",
    );
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(503);
    expect(serialized).not.toContain("sensitive");
    expect(serialized).not.toContain("postgresql");
  });

  it("trusts only one proxy-authenticated network address in production", async () => {
    const { requestRateLimitDiscriminator } = await import("../../src/lib/server/api-route");
    process.env.APP_ENV = "production";
    const valid = new Request("https://set-livre.example/api/commands", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(requestRateLimitDiscriminator(valid)).toMatch(/^[0-9a-f]{64}$/u);

    for (const value of [null, "", "203.0.113.10, 198.51.100.2", "host.invalid"]) {
      const init = value === null ? {} : { headers: { "x-forwarded-for": value } };
      expect(() =>
        requestRateLimitDiscriminator(new Request("https://set-livre.example/api/commands", init)),
      ).toThrow("origem de rede");
    }
  });

  it("rejects an exhausted facade bucket before parsing or executing the route", async () => {
    const { requestRateLimitDiscriminator } = await import("../../src/lib/server/api-route");
    const { runIdentityPostRoute } =
      await import("../../src/domains/identity/server/identity-route");
    const { enforceIdentityRateLimit, resetIdentityRateLimitForTests } =
      await import("../../src/lib/server/rate-limit");
    const request = new Request("http://127.0.0.1:3000/api/auth/login", {
      body: "not-json",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      },
      method: "POST",
    });
    const discriminator = requestRateLimitDiscriminator(request);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      enforceIdentityRateLimit("identity.login.request", discriminator, {
        limit: 300,
        windowMs: 60_000,
      });
    }
    const execute = vi.fn(async () => ({ data: { unexpected: true } }));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const response = await runIdentityPostRoute(request, "identity.login", execute);

    expect(response.status).toBe(429);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("not-json");
    output.mockRestore();
    resetIdentityRateLimitForTests();
  });

  it("keeps recovery enumeration-safe while recording provider degradation", async () => {
    const { runIdentityPostRoute } =
      await import("../../src/domains/identity/server/identity-route");
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
    const request = new Request("http://127.0.0.1:3000/api/auth/recovery/request", {
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      method: "POST",
    });
    const events: string[] = [];
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => (events.push(String(chunk)), true));

    const response = await runIdentityPostRoute(request, "identity.recovery.request", async () => ({
      data: { accepted: true },
      operationalOutcome: "unavailable",
      status: 202,
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ data: { accepted: true } });
    expect(events.join("\n")).toContain('"outcome":"unavailable"');
    expect(events.join("\n")).not.toContain("email");
    output.mockRestore();
    resetIdentityRateLimitForTests();
  });
});

describe("bounded rate limiter", () => {
  it("enforces a fixed window and allows the next one", async () => {
    const { BoundedFixedWindowRateLimiter } = await import("../../src/lib/server/rate-limit");
    const limiter = new BoundedFixedWindowRateLimiter(2);
    expect(limiter.consume("identity.login", "one", 2, 1_000, 10)).toBe(true);
    expect(limiter.consume("identity.login", "one", 2, 1_000, 20)).toBe(true);
    expect(limiter.consume("identity.login", "one", 2, 1_000, 30)).toBe(false);
    expect(limiter.consume("identity.login", "one", 2, 1_000, 1_011)).toBe(true);
  });

  it("admits a different action after 10,000 hostile live buckets fill the store", async () => {
    const { BoundedFixedWindowRateLimiter } = await import("../../src/lib/server/rate-limit");
    const limiter = new BoundedFixedWindowRateLimiter(10_000);
    for (let index = 0; index < 10_000; index += 1) {
      expect(limiter.consume("identity.login", `hostile-${index}`, 1, 60_000, 10 + index)).toBe(
        true,
      );
    }

    expect(limiter.consume("identity.recovery.update", "legitimate", 1, 60_000, 10_010)).toBe(true);
    expect(limiter.consume("identity.recovery.update", "legitimate", 1, 60_000, 10_011)).toBe(
      false,
    );
  });

  it("contains capacity churn in its action while retaining another action's exhausted bucket", async () => {
    const { BoundedFixedWindowRateLimiter } = await import("../../src/lib/server/rate-limit");
    const limiter = new BoundedFixedWindowRateLimiter(4);
    expect(limiter.consume("identity.login", "hostile-one", 1, 1_000, 10)).toBe(true);
    expect(limiter.consume("identity.login", "hostile-two", 1, 1_000, 20)).toBe(true);
    expect(limiter.consume("identity.login", "hostile-three", 1, 1_000, 30)).toBe(true);
    expect(limiter.consume("identity.recovery.update", "protected", 1, 1_000, 40)).toBe(true);

    expect(limiter.consume("identity.recovery.update", "second", 1, 1_000, 50)).toBe(true);
    expect(limiter.consume("identity.recovery.update", "protected", 1, 1_000, 60)).toBe(false);
    expect(limiter.consume("identity.login", "hostile-four", 1, 1_000, 70)).toBe(true);
    expect(limiter.consume("identity.register", "new-action", 1, 1_000, 80)).toBe(true);
    expect(limiter.consume("identity.recovery.update", "protected", 1, 1_000, 90)).toBe(false);
  });

  it("never evicts a live exhausted bucket to admit churn in the same action", async () => {
    const { BoundedFixedWindowRateLimiter } = await import("../../src/lib/server/rate-limit");
    const limiter = new BoundedFixedWindowRateLimiter(2);
    expect(limiter.consume("identity.login", "protected", 1, 1_000, 10)).toBe(true);
    expect(limiter.consume("identity.login", "protected", 1, 1_000, 20)).toBe(false);
    expect(limiter.consume("identity.login", "hostile-one", 1, 1_000, 30)).toBe(true);
    expect(limiter.consume("identity.login", "hostile-two", 1, 1_000, 40)).toBe(true);

    for (let index = 3; index < 20; index += 1) {
      expect(limiter.consume("identity.login", `hostile-${index}`, 1, 1_000, 40 + index)).toBe(
        false,
      );
    }

    expect(limiter.consume("identity.login", "protected", 1, 1_000, 100)).toBe(false);
  });

  it("keeps a partition overflow sticky until reset while an exact slot expires", async () => {
    const { BoundedFixedWindowRateLimiter } = await import("../../src/lib/server/rate-limit");
    const limiter = new BoundedFixedWindowRateLimiter(1);
    expect(limiter.consume("identity.login", "exact", 1, 100, 10)).toBe(true);
    expect(limiter.consume("identity.login", "overflow-one", 2, 1_000, 20)).toBe(true);
    expect(limiter.consume("identity.login", "overflow-two", 2, 1_000, 30)).toBe(true);
    expect(limiter.consume("identity.login", "overflow-three", 2, 1_000, 120)).toBe(false);
    expect(limiter.storageSizeForTests()).toEqual({ exactBuckets: 0, overflowCounters: 1 });
    expect(limiter.consume("identity.login", "overflow-three", 2, 1_000, 1_021)).toBe(true);
    expect(limiter.storageSizeForTests()).toEqual({ exactBuckets: 1, overflowCounters: 0 });
    expect(limiter.consume("identity.login", "overflow-three", 2, 1_000, 1_022)).toBe(true);
    expect(limiter.consume("identity.login", "overflow-three", 2, 1_000, 1_023)).toBe(false);
  });

  it("isolates bounded overflow counters by action and fails closed beyond their metadata cap", async () => {
    const { BoundedFixedWindowRateLimiter } = await import("../../src/lib/server/rate-limit");
    const limiter = new BoundedFixedWindowRateLimiter(2);
    expect(limiter.consume("identity.login", "exact-one", 1, 1_000, 10)).toBe(true);
    expect(limiter.consume("identity.login", "exact-two", 1, 1_000, 20)).toBe(true);

    expect(limiter.consume("identity.recovery.request", "overflow-one", 1, 1_000, 30)).toBe(true);
    expect(limiter.consume("identity.recovery.request", "overflow-two", 1, 1_000, 40)).toBe(false);
    expect(limiter.consume("identity.register", "isolated", 1, 1_000, 50)).toBe(true);
    expect(limiter.consume("identity.register", "isolated-again", 1, 1_000, 60)).toBe(false);
    expect(limiter.consume("identity.recovery.request", "still-isolated", 1, 1_000, 65)).toBe(
      false,
    );
    expect(limiter.consume("identity.callback", "metadata-cap", 1, 1_000, 70)).toBe(false);
    expect(limiter.storageSizeForTests()).toEqual({ exactBuckets: 2, overflowCounters: 2 });
    expect(limiter.consume("identity.login", "exact-one", 1, 1_000, 80)).toBe(false);
  });
});
