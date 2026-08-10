import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as getBackofficeLiveness } from "../../apps/backoffice/src/app/api/health/live/route";
import { GET as getWebLiveness } from "../../src/app/api/health/live/route";

const requestId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";

describe("liveness routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["web", getWebLiveness, undefined],
    ["backoffice", getBackofficeLiveness, "not-a-release-sha"],
  ] as const)(
    "keeps the %s process observable without a valid release",
    async (application, getLiveness, release) => {
      vi.stubEnv("APP_RELEASE_SHA", release);

      const response = getLiveness(
        new Request("http://127.0.0.1/api/health/live", {
          headers: { "x-request-id": requestId },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-request-id")).toBe(requestId);
      await expect(response.json()).resolves.toMatchObject({
        application,
        release: "unknown",
        requestId,
        status: "live",
      });
    },
  );
});
