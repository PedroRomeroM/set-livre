import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  requireRouteBackofficeSession: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../apps/backoffice/src/lib/supabase/config", () => ({
  readBackofficeSupabaseEnvironment: () => ({
    accessMode: "reverse-proxy",
    appOrigin: "http://backoffice.local",
    environment: "local",
  }),
}));
vi.mock(
  "../../apps/backoffice/src/domains/backoffice/server/backoffice-session",
  () => sessionMocks,
);

import { BackofficeApiError } from "../../apps/backoffice/src/lib/server/api-route";
import { runProtectedBackofficeRoute } from "../../apps/backoffice/src/lib/server/protected-api-route";
import {
  backofficeIdentityActionDiscriminator,
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
  sessionMocks.requireRouteBackofficeSession.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
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
