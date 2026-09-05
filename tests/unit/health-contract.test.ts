import { describe, expect, it, vi } from "vitest";

import {
  createHealthPayload,
  databaseMigrationHead,
  evaluateLiveness,
  evaluateReadiness,
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

  it.each([
    ["web", undefined],
    ["backoffice", "not-a-release-sha"],
  ] as const)(
    "keeps %s live with controlled metadata when release is unavailable",
    (application, releaseCandidate) => {
      const requestId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";

      const result = evaluateLiveness(
        application,
        requestId,
        releaseCandidate,
        new Date("2026-08-09T12:00:00.000Z"),
      );

      expect(result).toEqual({
        headers: {
          "cache-control": "no-store",
          "x-request-id": requestId,
        },
        payload: {
          application,
          checkedAt: "2026-08-09T12:00:00.000Z",
          release: "unknown",
          requestId,
          status: "live",
        },
        status: 200,
      });
      expect(healthPayloadSchema.safeParse(result.payload).success).toBe(true);
    },
  );

  it("preserves a valid release on liveness", () => {
    const result = evaluateLiveness(
      "web",
      "e65fe64c-3788-4cf0-beb3-c344025b0bb0",
      "local",
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(result.payload).toMatchObject({ release: "local", status: "live" });
    expect(result.status).toBe(200);
  });

  it.each([
    ["web", undefined],
    ["backoffice", "not-a-release-sha"],
  ] as const)(
    "returns authoritative %s unready metadata for an invalid release",
    async (application, releaseCandidate) => {
      const dependencyCheck = vi.fn(() => true);
      const requestId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";

      const result = await evaluateReadiness(
        application,
        requestId,
        releaseCandidate,
        dependencyCheck,
        new Date("2026-08-09T12:00:00.000Z"),
      );

      expect(dependencyCheck).not.toHaveBeenCalled();
      expect(result).toEqual({
        headers: {
          "cache-control": "no-store",
          "x-request-id": requestId,
        },
        payload: {
          application,
          checkedAt: "2026-08-09T12:00:00.000Z",
          release: "unknown",
          requestId,
          status: "unready",
        },
        status: 503,
      });
      expect(healthPayloadSchema.safeParse(result.payload).success).toBe(true);
    },
  );

  it("returns ready only when release and dependency are both valid", async () => {
    const requestId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";
    const dependencyCheck = vi.fn(() => true);

    const result = await evaluateReadiness(
      "backoffice",
      requestId,
      "0123456789abcdef0123456789abcdef01234567",
      dependencyCheck,
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(dependencyCheck).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      application: "backoffice",
      release: "0123456789abcdef0123456789abcdef01234567",
      requestId,
      status: "ready",
    });
  });

  it("fails closed without exposing a dependency exception", async () => {
    const requestId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";

    const result = await evaluateReadiness(
      "web",
      requestId,
      "local",
      () => Promise.reject(new Error("sensitive database detail")),
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(result.status).toBe(503);
    expect(result.payload).toEqual({
      application: "web",
      checkedAt: "2026-08-09T12:00:00.000Z",
      release: "local",
      requestId,
      status: "unready",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive database detail");
  });

  it("allows an unknown release on observable non-ready payloads", () => {
    const base = {
      application: "web",
      checkedAt: "2026-08-09T12:00:00.000Z",
      release: "unknown",
      requestId: "e65fe64c-3788-4cf0-beb3-c344025b0bb0",
    };

    expect(healthPayloadSchema.safeParse({ ...base, status: "unready" }).success).toBe(true);
    expect(healthPayloadSchema.safeParse({ ...base, status: "ready" }).success).toBe(false);
    expect(healthPayloadSchema.safeParse({ ...base, status: "live" }).success).toBe(true);
  });

  it("propagates only a valid request ID", () => {
    const valid = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";

    expect(resolveRequestId(valid)).toBe(valid);
    expect(resolveRequestId("attacker-controlled-value")).not.toBe("attacker-controlled-value");
  });

  it("pins the readiness contract to the current migration", () => {
    expect(databaseMigrationHead).toBe("20260905163830");
  });
});
