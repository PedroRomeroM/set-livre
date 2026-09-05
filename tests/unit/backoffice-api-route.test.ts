import { randomUUID } from "node:crypto";
import type { BackofficeServerSession } from "../../apps/backoffice/src/domains/backoffice/server/backoffice-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  readRouteBackofficeSession: vi.fn(),
  requireRouteBackofficeSession: vi.fn(),
  toBrowserBackofficeSession: vi.fn(),
}));
const environmentMocks = vi.hoisted(() => ({ readBackofficeSupabaseEnvironment: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../apps/backoffice/src/lib/supabase/config", () => environmentMocks);
vi.mock(
  "../../apps/backoffice/src/domains/backoffice/server/backoffice-session",
  () => sessionMocks,
);

import { GET as getBackofficeSession } from "../../apps/backoffice/src/app/api/auth/session/route";
import { BackofficeApiError } from "../../apps/backoffice/src/lib/server/api-route";
import { runProtectedBackofficeRoute } from "../../apps/backoffice/src/lib/server/protected-api-route";
import {
  backofficeIdentityActionDiscriminator,
  enforceBackofficeCommandIdentityRateLimits,
  enforceBackofficeRateLimit,
} from "../../apps/backoffice/src/lib/server/rate-limit";
import {
  mergeBackofficeSupabaseResponseHeaders,
  withBackofficeSupabaseResponseHeaderMerge,
} from "../../apps/backoffice/src/lib/supabase/server";

function protectedRequest() {
  return new Request("http://backoffice.local/api/commands", {
    headers: {
      host: "backoffice.local",
      origin: "http://backoffice.local",
    },
    method: "POST",
  });
}

beforeEach(() => {
  environmentMocks.readBackofficeSupabaseEnvironment.mockReturnValue({
    accessMode: "reverse-proxy",
    appOrigin: "http://backoffice.local",
    environment: "local",
  });
  sessionMocks.readRouteBackofficeSession.mockReset();
  sessionMocks.requireRouteBackofficeSession.mockReset();
  sessionMocks.toBrowserBackofficeSession.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("backoffice session polling rate limits", () => {
  let clockWindow = 0;
  const userA = "a1000000-0000-4000-8000-000000000001";
  const userB = "a1000000-0000-4000-8000-000000000002";
  const sessionA = "b1000000-0000-4000-8000-000000000001";
  const sessionB = "b1000000-0000-4000-8000-000000000002";

  function sessionRequest(headers?: Record<string, string>) {
    return new Request("http://127.0.0.1:3001/api/auth/session", {
      headers: {
        host: "127.0.0.1:3001",
        "x-forwarded-host": "127.0.0.1:3001",
        "x-forwarded-proto": "http",
        ...headers,
      },
    });
  }

  function authenticatedSession(scope = userA, authSessionId = sessionA): BackofficeServerSession {
    return {
      authenticated: true,
      authorizationVersion: 1,
      authSessionId,
      email: "operator@example.test",
      expiresAt: "2026-09-06T13:00:00.000Z",
      roles: ["admin"],
      scope,
      strongAuthenticationExpiresAt: "2026-09-06T12:05:00.000Z",
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z").getTime() + clockWindow++ * 120_000);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    environmentMocks.readBackofficeSupabaseEnvironment.mockReturnValue({
      accessMode: "ssh-tunnel",
      appOrigin: "http://127.0.0.1:3001",
      environment: "production",
    });
    sessionMocks.toBrowserBackofficeSession.mockImplementation(
      (session: BackofficeServerSession) =>
        session.authenticated
          ? {
              authenticated: true,
              authorizationVersion: session.authorizationVersion,
              email: session.email,
              expiresAt: session.expiresAt,
              runtimeUnlockExpiresAt: null,
              scope: session.scope,
              strongAuthenticationExpiresAt: session.strongAuthenticationExpiresAt,
            }
          : { authenticated: false },
    );
  });

  it("accepts four polling rounds from 31 operators behind the same SSH tunnel", async () => {
    for (let round = 0; round < 4; round += 1) {
      for (let operator = 1; operator <= 31; operator += 1) {
        const suffix = String(operator).padStart(12, "0");
        sessionMocks.readRouteBackofficeSession.mockResolvedValueOnce({
          session: authenticatedSession(
            `a1000000-0000-4000-8000-${suffix}`,
            `b1000000-0000-4000-8000-${suffix}`,
          ),
          responseHeaders: new Headers(),
        });
        expect((await getBackofficeSession(sessionRequest())).status).toBe(200);
      }
      vi.advanceTimersByTime(15_000);
    }
    expect(sessionMocks.readRouteBackofficeSession).toHaveBeenCalledTimes(124);
  });

  it("shares a quota across tabs of one verified session, not other sessions or operators", async () => {
    const headers = new Headers({ "x-session-refresh": "preserved" });
    headers.append("set-cookie", "session-refresh=unit-test; Path=/; HttpOnly");
    sessionMocks.readRouteBackofficeSession.mockResolvedValue({
      session: authenticatedSession(),
      responseHeaders: headers,
    });
    for (let request = 0; request < 120; request += 1) {
      expect((await getBackofficeSession(sessionRequest())).status).toBe(200);
    }
    const limited = await getBackofficeSession(
      sessionRequest({
        "x-user-id": userB,
        "x-session-id": sessionB,
        "x-forwarded-for": "203.0.113.25",
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-session-refresh")).toBe("preserved");
    expect(limited.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(limited.headers.get("cache-control")).toBe("private, no-store");
    await expect(limited.json()).resolves.toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(sessionMocks.toBrowserBackofficeSession).toHaveBeenCalledTimes(120);

    for (const session of [
      authenticatedSession(userA, sessionB),
      authenticatedSession(userB, sessionA),
    ]) {
      sessionMocks.readRouteBackofficeSession.mockResolvedValueOnce({
        session,
        responseHeaders: new Headers(),
      });
      const response = await getBackofficeSession(sessionRequest());
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain("authSessionId");
      expect(body).not.toContain("roles");
    }
    vi.advanceTimersByTime(60_000);
    expect((await getBackofficeSession(sessionRequest())).status).toBe(200);
  });

  it("keeps anonymous and invalid credentials in a bounded network quota without charging operators", async () => {
    sessionMocks.readRouteBackofficeSession.mockResolvedValue({
      session: { authenticated: false },
      responseHeaders: new Headers({ "x-session-refresh": "cleared" }),
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await getBackofficeSession(
        sessionRequest({
          cookie: `untrusted-session=${attempt}`,
          "x-user-id": `forged-${attempt}`,
          "x-session-id": `forged-${attempt}`,
          "x-forwarded-for": `203.0.113.${attempt + 1}`,
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ data: { authenticated: false } });
    }
    const limited = await getBackofficeSession(sessionRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-session-refresh")).toBe("cleared");
    sessionMocks.readRouteBackofficeSession.mockResolvedValueOnce({
      session: authenticatedSession(),
      responseHeaders: new Headers(),
    });
    expect((await getBackofficeSession(sessionRequest())).status).toBe(200);
  });

  it("charges unsuccessful session verification to the anonymous quota and never returns private data", async () => {
    sessionMocks.readRouteBackofficeSession.mockRejectedValue(
      new Error("private-provider-diagnostic"),
    );
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await getBackofficeSession(sessionRequest());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-provider-diagnostic");
    }
    expect((await getBackofficeSession(sessionRequest())).status).toBe(429);
    expect(sessionMocks.toBrowserBackofficeSession).not.toHaveBeenCalled();
  });

  it("bounds canonical authentication work even when credentials rotate or verification fails", async () => {
    sessionMocks.readRouteBackofficeSession.mockRejectedValue(new Error("unavailable"));
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await getBackofficeSession(sessionRequest({ cookie: `untrusted-session=${attempt}` }));
    }
    expect(sessionMocks.readRouteBackofficeSession).toHaveBeenCalledTimes(600);
    expect((await getBackofficeSession(sessionRequest())).status).toBe(429);
    expect(sessionMocks.readRouteBackofficeSession).toHaveBeenCalledTimes(600);
    expect(sessionMocks.toBrowserBackofficeSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect((await getBackofficeSession(sessionRequest())).status).toBe(503);
    expect(sessionMocks.readRouteBackofficeSession).toHaveBeenCalledTimes(601);
  });

  it("rejects an untrusted host before reading authentication or allocating a session quota", async () => {
    const response = await getBackofficeSession(sessionRequest({ host: "untrusted.example" }));
    expect(response.status).toBe(403);
    expect(sessionMocks.readRouteBackofficeSession).not.toHaveBeenCalled();
    expect(sessionMocks.toBrowserBackofficeSession).not.toHaveBeenCalled();
  });
});

describe("backoffice command telemetry", () => {
  it("keeps telemetry generic until the protected callback validates an action", async () => {
    const operationalLog = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    sessionMocks.requireRouteBackofficeSession.mockResolvedValue({
      responseHeaders: new Headers(),
    });
    const rejectInvalidAction = vi.fn((): "backoffice.studio.approve" => {
      throw new BackofficeApiError(422, "VALIDATION_FAILED", "Action inválida.");
    });

    const beforeValidation = await runProtectedBackofficeRoute(
      protectedRequest(),
      "backoffice.command",
      async ({ setAction }) => {
        setAction(rejectInvalidAction());
        return { data: { accepted: true } };
      },
    );
    const afterValidation = await runProtectedBackofficeRoute(
      protectedRequest(),
      "backoffice.command",
      async ({ setAction }) => {
        setAction("backoffice.studio.approve");
        throw new BackofficeApiError(429, "RATE_LIMITED", "Tente novamente depois.");
      },
    );

    expect(beforeValidation.status).toBe(422);
    expect(afterValidation.status).toBe(429);
    expect(operationalLog).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('"action":"backoffice.command"'),
    );
    expect(operationalLog).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('"action":"backoffice.studio.approve"'),
    );
  });

  it("partitions command limits by a private hash of identity and validated action", () => {
    const scope = "a1000000-0000-4000-8000-000000000099";
    const approve = backofficeIdentityActionDiscriminator(scope, "backoffice.studio.approve");
    const reject = backofficeIdentityActionDiscriminator(scope, "backoffice.studio.reject");

    expect(approve).toMatch(/^[a-f0-9]{64}$/u);
    expect(approve).not.toContain(scope);
    expect(approve).not.toContain("approve");
    expect(reject).not.toBe(approve);
    expect(backofficeIdentityActionDiscriminator(scope, "backoffice.studio.approve")).toBe(approve);
  });

  it("enforces identity and action buckets independently from the shared network bucket", () => {
    const partition = `unit.backoffice.commands.${randomUUID()}`;
    const scope = "a1000000-0000-4000-8000-000000000099";
    const approve = backofficeIdentityActionDiscriminator(scope, "backoffice.studio.approve");
    const reject = backofficeIdentityActionDiscriminator(scope, "backoffice.studio.reject");
    const options = { limit: 1, windowMs: 60_000 } as const;

    enforceBackofficeRateLimit(partition, approve, options);
    expect(() => enforceBackofficeRateLimit(partition, approve, options)).toThrowError(
      BackofficeApiError,
    );
    expect(() => enforceBackofficeRateLimit(partition, reject, options)).not.toThrow();
  });

  it("shares a 20-per-hour ceiling across destructive commands for one identity", () => {
    const scope = randomUUID();
    const destructiveActions = [
      "backoffice.user.suspend",
      "backoffice.access.revokeSupport",
      "backoffice.access.revokeReviewer",
      "backoffice.access.revokeAdmin",
      "backoffice.taxonomy.archive",
      "backoffice.studio.disable",
    ] as const;

    for (let round = 0; round < 3; round += 1) {
      for (const action of destructiveActions) {
        expect(() => enforceBackofficeCommandIdentityRateLimits(scope, action)).not.toThrow();
      }
    }
    expect(() =>
      enforceBackofficeCommandIdentityRateLimits(scope, "backoffice.user.suspend"),
    ).not.toThrow();
    expect(() =>
      enforceBackofficeCommandIdentityRateLimits(scope, "backoffice.access.revokeAdmin"),
    ).not.toThrow();

    expect(() =>
      enforceBackofficeCommandIdentityRateLimits(scope, "backoffice.studio.disable"),
    ).toThrowError(BackofficeApiError);
    expect(() =>
      enforceBackofficeCommandIdentityRateLimits(scope, "backoffice.studio.restore"),
    ).not.toThrow();
    expect(() =>
      enforceBackofficeCommandIdentityRateLimits(randomUUID(), "backoffice.studio.disable"),
    ).not.toThrow();
  });

  it("retains the per-action burst guard for non-destructive commands", () => {
    const scope = randomUUID();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(() =>
        enforceBackofficeCommandIdentityRateLimits(scope, "backoffice.studio.approve"),
      ).not.toThrow();
    }
    expect(() =>
      enforceBackofficeCommandIdentityRateLimits(scope, "backoffice.studio.approve"),
    ).toThrowError(BackofficeApiError);
  });

  it("stops rate limit, body parsing and execution when authentication fails", async () => {
    const operationalLog = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const rateLimit = vi.fn();
    const readBody = vi.fn();
    const execute = vi.fn();
    const protectedCallback = vi.fn(async () => {
      rateLimit();
      readBody();
      execute();
      return { data: { accepted: true } };
    });
    sessionMocks.requireRouteBackofficeSession.mockRejectedValue(
      new BackofficeApiError(401, "UNAUTHENTICATED", "Entre novamente para continuar."),
    );

    const response = await runProtectedBackofficeRoute(
      protectedRequest(),
      "backoffice.command",
      protectedCallback,
    );

    expect(response.status).toBe(401);
    expect(sessionMocks.requireRouteBackofficeSession).toHaveBeenCalledTimes(1);
    expect(protectedCallback).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(operationalLog).toHaveBeenCalledTimes(1);
  });

  it("runs authentication before the callback and preserves its headers on downstream rejection", async () => {
    const operationalLog = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const order: string[] = [];
    sessionMocks.requireRouteBackofficeSession.mockImplementation(async () => {
      order.push("auth");
      return { responseHeaders: new Headers({ "x-session-refresh": "preserved" }) };
    });

    const response = await runProtectedBackofficeRoute(
      protectedRequest(),
      "backoffice.command",
      async () => {
        order.push("callback");
        throw new BackofficeApiError(429, "RATE_LIMITED", "Tente novamente depois.");
      },
    );

    expect(order).toEqual(["auth", "callback"]);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-session-refresh")).toBe("preserved");
    expect(operationalLog).toHaveBeenCalledTimes(1);
  });
});

describe("backoffice Supabase response headers", () => {
  it("preserves every prior and refreshed cookie while merging signing headers", () => {
    const target = new Headers({ "x-middleware-set-cookie": "prior=1; Path=/" });
    target.append("set-cookie", "prior=1; Path=/");
    const source = new Headers({
      "x-middleware-set-cookie": "access=2; Path=/,refresh=3; Path=/",
      "x-session-refresh": "preserved",
    });
    source.append("set-cookie", "access=2; Path=/");
    source.append("set-cookie", "refresh=3; Path=/");

    mergeBackofficeSupabaseResponseHeaders(target, source);

    expect(target.getSetCookie()).toEqual([
      "prior=1; Path=/",
      "access=2; Path=/",
      "refresh=3; Path=/",
    ]);
    expect(target.get("x-middleware-set-cookie")).toBe(
      "prior=1; Path=/, access=2; Path=/,refresh=3; Path=/",
    );
    expect(target.get("x-session-refresh")).toBe("preserved");
  });

  it("waits for late session refreshes before merging signing headers", async () => {
    const target = new Headers();
    const source = new Headers();

    const result = await withBackofficeSupabaseResponseHeaderMerge(
      target,
      async (captureResponseHeaders) => {
        captureResponseHeaders(source);
        expect(target.getSetCookie()).toEqual([]);
        source.append("set-cookie", "access=2; Path=/");
        source.append("set-cookie", "refresh=3; Path=/");
        return "signed";
      },
    );

    expect(result).toBe("signed");
    expect(target.getSetCookie()).toEqual(["access=2; Path=/", "refresh=3; Path=/"]);
  });
});
