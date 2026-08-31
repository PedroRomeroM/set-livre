import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../apps/backoffice/src/lib/supabase/config", () => ({
  readBackofficeSupabaseEnvironment: () => ({
    accessMode: "reverse-proxy",
    appOrigin: "http://backoffice.local",
    environment: "local",
  }),
}));

import {
  BackofficeApiError,
  runBackofficeRoute,
} from "../../apps/backoffice/src/lib/server/api-route";

describe("backoffice command telemetry", () => {
  it("uses a generic action until a command discriminator has been validated", () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), "apps/backoffice/src/app/api/commands/route.ts"),
      "utf8",
    );
    const apiRouteSource = readFileSync(
      resolve(process.cwd(), "apps/backoffice/src/lib/server/api-route.ts"),
      "utf8",
    );

    expect(routeSource).toMatch(/runBackofficeRoute\(\s*request,\s*"backoffice\.command"/u);
    expect(apiRouteSource).toContain('"backoffice.command"');
    expect(routeSource.indexOf("parseOrBackofficeInputError(")).toBeLessThan(
      routeSource.indexOf("setAction(command.action)"),
    );
    expect(routeSource).not.toMatch(
      /runBackofficeRoute\(\s*request,\s*"backoffice\.user\.suspend"/u,
    );
  });

  it("authenticates every private backoffice surface before rate limiting or reading a body", () => {
    const routePaths = [
      "apps/backoffice/src/app/api/commands/route.ts",
      "apps/backoffice/src/app/api/taxonomies/route.ts",
      "apps/backoffice/src/app/api/users/route.ts",
    ];

    for (const routePath of routePaths) {
      const routeSource = readFileSync(resolve(process.cwd(), routePath), "utf8");
      const authentication = routeSource.indexOf("await requireRouteBackofficeSession()");
      const rateLimit = routeSource.indexOf("enforceBackofficeRateLimit(");
      const bodyRead = routeSource.indexOf("await readLimitedJson(request)");

      expect(authentication, routePath).toBeGreaterThan(-1);
      expect(authentication, routePath).toBeLessThan(rateLimit);
      if (bodyRead !== -1) expect(authentication, routePath).toBeLessThan(bodyRead);
    }

    const serviceSource = readFileSync(
      resolve(process.cwd(), "apps/backoffice/src/domains/backoffice/server/backoffice-service.ts"),
      "utf8",
    );
    expect(serviceSource).not.toContain("await requireRouteBackofficeSession()");
  });

  it("preserves session response headers when a downstream stage rejects the request", async () => {
    const operationalLog = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const response = await runBackofficeRoute(
        new Request("http://backoffice.local/api/commands", {
          headers: {
            host: "backoffice.local",
            origin: "http://backoffice.local",
          },
          method: "POST",
        }),
        "backoffice.command",
        async (_requestId, _setAction, setResponseHeaders) => {
          setResponseHeaders({ "x-session-refresh": "preserved" });
          throw new BackofficeApiError(429, "RATE_LIMITED", "Tente novamente depois.");
        },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("x-session-refresh")).toBe("preserved");
    } finally {
      operationalLog.mockRestore();
    }
  });
});
