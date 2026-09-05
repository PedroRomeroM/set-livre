import { afterEach, describe, expect, it, vi } from "vitest";

import { startE2EMaintenanceHeartbeat } from "../helpers/e2e-database-preflight";

describe("Playwright local maintenance heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once before the suite, repeats on the production cadence and stops cleanly", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const stop = await startE2EMaintenanceHeartbeat({ intervalMs: 100, run });

    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(4);

    await stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("fails the gate when a scheduled cleanup does not finish successfully", async () => {
    vi.useFakeTimers();
    const run = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup failed"));
    const stop = await startE2EMaintenanceHeartbeat({ intervalMs: 100, run });

    await vi.advanceTimersByTimeAsync(100);
    await expect(stop()).rejects.toThrow("cleanup failed");
  });
});
