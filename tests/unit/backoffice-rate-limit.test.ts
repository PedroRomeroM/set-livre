import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BackofficeApiError } from "../../apps/backoffice/src/lib/server/api-route";
import { enforceBackofficeRateLimit } from "../../apps/backoffice/src/lib/server/rate-limit";

afterEach(() => {
  vi.useRealTimers();
});

describe("backoffice rate-limit storage", () => {
  it("rotates the bounded sweep and reclaims expired buckets beyond a live prefix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const partition = "unit.backoffice.sweep";

    for (let index = 0; index < 16; index += 1) {
      enforceBackofficeRateLimit(partition, `live-${index}`, {
        limit: 2,
        windowMs: 60_000,
      });
    }
    for (let index = 16; index < 2_000; index += 1) {
      enforceBackofficeRateLimit(partition, `expired-${index}`, {
        limit: 2,
        windowMs: 1_000,
      });
    }

    vi.advanceTimersByTime(2_000);
    let replacementAccepted = false;
    for (let attempt = 0; attempt < 126; attempt += 1) {
      try {
        enforceBackofficeRateLimit(partition, `replacement-${attempt}`, {
          limit: 2,
          windowMs: 1_000,
        });
        replacementAccepted = true;
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(BackofficeApiError);
        expect(error).toMatchObject({ code: "RATE_LIMITED", status: 429 });
      }
    }

    expect(replacementAccepted).toBe(true);
    expect(() =>
      enforceBackofficeRateLimit(partition, "live-0", { limit: 2, windowMs: 60_000 }),
    ).not.toThrow();
    expect(() =>
      enforceBackofficeRateLimit(partition, "live-0", { limit: 2, windowMs: 60_000 }),
    ).toThrowError(BackofficeApiError);
  });
});
