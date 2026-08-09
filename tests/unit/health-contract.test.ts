import { describe, expect, it } from "vitest";

import {
  createHealthPayload,
  databaseMigrationHead,
  healthPayloadSchema,
  resolveRequestId,
} from "../../packages/contracts/src";

describe("health contract", () => {
  it("creates an explicit and validated payload", () => {
    const checkedAt = new Date("2026-08-09T12:00:00.000Z");
    const requestId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";

    const result = createHealthPayload("web", "live", requestId, "local", checkedAt);

    expect(result).toEqual({
      application: "web",
      checkedAt: "2026-08-09T12:00:00.000Z",
      release: "local",
      requestId,
      status: "live",
    });
    expect(healthPayloadSchema.safeParse(result).success).toBe(true);
  });

  it("rejects unsupported application names", () => {
    expect(
      healthPayloadSchema.safeParse({
        application: "admin",
        checkedAt: "2026-08-09T12:00:00.000Z",
        release: "local",
        requestId: "e65fe64c-3788-4cf0-beb3-c344025b0bb0",
        status: "ready",
      }).success,
    ).toBe(false);
  });

  it("represents an unavailable dependency without exposing its error", () => {
    const result = createHealthPayload(
      "backoffice",
      "unready",
      "e65fe64c-3788-4cf0-beb3-c344025b0bb0",
      "0123456789abcdef0123456789abcdef01234567",
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(result.status).toBe("unready");
    expect(Object.keys(result)).toEqual([
      "application",
      "checkedAt",
      "release",
      "requestId",
      "status",
    ]);
  });

  it("propagates only a valid request ID", () => {
    const valid = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";

    expect(resolveRequestId(valid)).toBe(valid);
    expect(resolveRequestId("attacker-controlled-value")).not.toBe("attacker-controlled-value");
  });

  it("pins the readiness contract to the current migration", () => {
    expect(databaseMigrationHead).toBe("20260809000300");
  });
});
