import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  configurations: [] as unknown[],
  loadDalPostgresConnectionConfig: vi.fn(),
  poolOn: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@set-livre/contracts/server/postgres-connection-config", () => ({
  loadDalPostgresConnectionConfig: mocks.loadDalPostgresConnectionConfig,
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
    vi.resetModules();
    mocks.configurations.length = 0;
    vi.clearAllMocks();
    mocks.loadDalPostgresConnectionConfig.mockReturnValue({
      connectionString:
        "postgresql://app_runtime:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
      sessionRole: "app_runtime",
      ssl: false,
    });
    mocks.query.mockRejectedValue(new Error("readiness unavailable in unit test"));
  });

  it("creates one command pool capped at six connections", async () => {
    const { commandDalPool } = await import("../../src/lib/server/dal-pool");
    const first = commandDalPool();
    const second = commandDalPool();

    expect(first).toBe(second);
    expect(mocks.configurations).toEqual([
      expect.objectContaining({
        application_name: "set-livre-web-command-dal",
        max: 6,
        query_timeout: 2_000,
        ssl: false,
        statement_timeout: 2_000,
      }),
    ]);
  });

  it("passes the verified production CA to pg without weakening certificate checks", async () => {
    const ca = Buffer.from("verified production CA bytes");
    mocks.loadDalPostgresConnectionConfig.mockReturnValue({
      connectionString:
        "postgresql://app_runtime:secret@db.example.test:6543/postgres?options=-c%20role%3Dapp_dal",
      sessionRole: "app_runtime",
      ssl: { ca, rejectUnauthorized: true },
    });

    const { commandDalPool } = await import("../../src/lib/server/dal-pool");
    commandDalPool();

    expect(mocks.configurations).toEqual([
      expect.objectContaining({
        ssl: { ca, rejectUnauthorized: true },
      }),
    ]);
  });

  it("preserves a separate readiness pool capped at two connections", async () => {
    const { isDatabaseReady } = await import("../../src/lib/server/database-readiness");
    await expect(isDatabaseReady()).resolves.toBe(false);
    expect(mocks.configurations).toEqual([
      expect.objectContaining({
        application_name: "set-livre-web-readiness",
        max: 2,
        query_timeout: 1_000,
        ssl: false,
        statement_timeout: 1_000,
      }),
    ]);
  });

  it("passes the same verified CA to both readiness pools", async () => {
    const ca = Buffer.from("verified production CA bytes");
    mocks.loadDalPostgresConnectionConfig.mockReturnValue({
      connectionString:
        "postgresql://app_runtime:secret@db.example.test:6543/postgres?options=-c%20role%3Dapp_dal",
      sessionRole: "app_runtime",
      ssl: { ca, rejectUnauthorized: true },
    });

    const { isDatabaseReady: isWebDatabaseReady } =
      await import("../../src/lib/server/database-readiness");
    const { isDatabaseReady: isBackofficeDatabaseReady } =
      await import("../../apps/backoffice/src/lib/server/database-readiness");
    await expect(isWebDatabaseReady()).resolves.toBe(false);
    await expect(isBackofficeDatabaseReady()).resolves.toBe(false);

    expect(mocks.configurations).toEqual([
      expect.objectContaining({ ssl: { ca, rejectUnauthorized: true } }),
      expect.objectContaining({ ssl: { ca, rejectUnauthorized: true } }),
    ]);
  });

  it("keeps web commands plus both app readiness pools within the ten-connection login cap", async () => {
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
    expect(connectionBudget).toEqual([6, 2, 2]);
    expect(connectionBudget.reduce((total, maximum) => total + maximum, 0)).toBe(10);
  });
});
