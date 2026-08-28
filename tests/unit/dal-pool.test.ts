import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  configurations: [] as unknown[],
  poolOn: vi.fn(),
  query: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class Pool {
    constructor(configuration: unknown) {
      mocks.configurations.push(configuration);
    }

    on = mocks.poolOn;
    query = mocks.query;
  },
}));

describe("shared restricted command DAL pool", () => {
  beforeEach(() => {
    mocks.configurations.length = 0;
    vi.clearAllMocks();
    process.env.DATABASE_URL_APP_DAL =
      "postgresql://app_runtime:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
    mocks.query.mockRejectedValue(new Error("readiness unavailable in unit test"));
  });

  it("creates one command pool capped at four connections", async () => {
    const { commandDalPool } = await import("../../src/lib/server/dal-pool");
    const first = commandDalPool();
    const second = commandDalPool();

    expect(first).toBe(second);
    expect(mocks.configurations).toEqual([
      expect.objectContaining({
        application_name: "set-livre-web-command-dal",
        max: 4,
        query_timeout: 2_000,
        statement_timeout: 2_000,
      }),
    ]);
  });

  it("preserves a separate readiness pool capped at one connection", async () => {
    vi.resetModules();
    const { isDatabaseReady } = await import("../../src/lib/server/database-readiness");
    await expect(isDatabaseReady()).resolves.toBe(false);
    expect(mocks.configurations).toEqual([
      expect.objectContaining({
        application_name: "set-livre-web-readiness",
        max: 1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      }),
    ]);
  });

  it("reserves four production login slots for deploy and recovery", async () => {
    vi.resetModules();
    const { commandDalPool } = await import("../../src/lib/server/dal-pool");
    const { isDatabaseReady: isWebDatabaseReady } =
      await import("../../src/lib/server/database-readiness");
    const { isDatabaseReady: isBackofficeDatabaseReady } =
      await import("../../apps/backoffice/src/lib/server/database-readiness");

    commandDalPool();
    await expect(isWebDatabaseReady()).resolves.toBe(false);
    await expect(isBackofficeDatabaseReady()).resolves.toBe(false);

    const connectionBudget = mocks.configurations.map(
      (configuration) => z.object({ max: z.number().int().positive() }).parse(configuration).max,
    );
    const allocatedConnections = connectionBudget.reduce((total, maximum) => total + maximum, 0);
    expect(connectionBudget).toEqual([4, 1, 1]);
    expect(allocatedConnections).toBe(6);
    expect(10 - allocatedConnections).toBe(4);
  });
});
