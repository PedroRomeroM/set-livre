import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

    expect(routeSource).toContain('runBackofficeRoute(request, "backoffice.command"');
    expect(apiRouteSource).toContain('"backoffice.command"');
    expect(routeSource.indexOf("parseOrBackofficeInputError(")).toBeLessThan(
      routeSource.indexOf("setAction(command.action)"),
    );
    expect(routeSource).not.toContain('runBackofficeRoute(request, "backoffice.user.suspend"');
  });
});
