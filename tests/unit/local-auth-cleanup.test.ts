import { describe, expect, it, vi } from "vitest";

import {
  cleanupLocalAuthUserWithDependencies,
  type LocalAuthCleanupDependencies,
  type LocalAuthCleanupPool,
} from "../helpers/local-auth-cleanup";

const email = "qa_worker_auth_cleanup@set-livre.local";
const userId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";
const otherUserId = "df74fb75-8611-48d8-b407-fc3be63ada21";
const databaseUrl = "postgresql://postgres:unit-secret@127.0.0.1:54322/postgres";

function dependenciesFor(pool: LocalAuthCleanupPool, events: string[]) {
  const dependencies: LocalAuthCleanupDependencies = {
    adminDatabaseUrl: databaseUrl,
    createPool(receivedDatabaseUrl) {
      expect(receivedDatabaseUrl).toBe(databaseUrl);
      events.push("pool");
      return pool;
    },
    async preflight() {
      events.push("preflight");
    },
  };
  return dependencies;
}

async function capturedAsyncError(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw new Error("O teste recebeu uma falha assíncrona que não é Error.");
  }
  throw new Error("O teste esperava uma falha assíncrona.");
}

describe("exact local Auth user cleanup", () => {
  it("runs the existing preflight before a parameterized UUID and email deletion", async () => {
    const events: string[] = [];
    const query = vi.fn(async (text: string, values: readonly [string, string]) => {
      events.push("query");
      expect(text).toContain("delete from auth.users");
      expect(text).toContain("id = $1::uuid");
      expect(text).toContain("email = $2");
      expect(text).not.toMatch(/\blike\b|%/iu);
      expect(text).not.toContain(email);
      expect(text).not.toContain(userId);
      expect(values).toEqual([userId, email]);
      return { rowCount: 1, rows: [{ id: userId }] };
    });
    const pool: LocalAuthCleanupPool = {
      async end() {
        events.push("end");
      },
      query,
    };

    await expect(
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(pool, events)),
    ).resolves.toBe(true);
    expect(events).toEqual(["preflight", "pool", "query", "end"]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("is idempotent only for the same exact UUID and email pair", async () => {
    const events: string[] = [];
    const pool: LocalAuthCleanupPool = {
      async end() {
        events.push("end");
      },
      async query() {
        events.push("query");
        return { rowCount: 0, rows: [] };
      },
    };

    await expect(
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(pool, events)),
    ).resolves.toBe(false);
  });

  it.each([
    { email: "person@set-livre.local", userId },
    { email: "QA_worker_auth_cleanup@set-livre.local", userId },
    { email, userId: "not-a-uuid" },
  ])("rejects non-exact QA identity input before the preflight", async (input) => {
    const preflight = vi.fn(async () => undefined);
    const createPool = vi.fn(() => {
      throw new Error("pool must not be created");
    });

    await expect(
      cleanupLocalAuthUserWithDependencies(input, {
        adminDatabaseUrl: databaseUrl,
        createPool,
        preflight,
      }),
    ).rejects.toThrow();
    expect(preflight).not.toHaveBeenCalled();
    expect(createPool).not.toHaveBeenCalled();
  });

  it("fails closed when the local database preflight is not valid", async () => {
    const preflightSecret = "preflight-database-secret";
    const createPool = vi.fn(() => {
      throw new Error("pool must not be created");
    });
    const message = await capturedAsyncError(() =>
      cleanupLocalAuthUserWithDependencies(
        { email, userId },
        {
          adminDatabaseUrl: databaseUrl,
          createPool,
          preflight: async () => {
            throw new Error(preflightSecret);
          },
        },
      ),
    );

    expect(createPool).not.toHaveBeenCalled();
    expect(message).toContain("preflight");
    expect(message).not.toContain(preflightSecret);
    expect(message).not.toContain(databaseUrl);
  });

  it("redacts query and pool shutdown failures without skipping shutdown", async () => {
    const events: string[] = [];
    const querySecret = "query-provider-secret";
    const shutdownSecret = "shutdown-provider-secret";
    const pool: LocalAuthCleanupPool = {
      async end() {
        events.push("end");
        throw new Error(shutdownSecret);
      },
      async query() {
        events.push("query");
        throw new Error(querySecret);
      },
    };

    const message = await capturedAsyncError(() =>
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(pool, events)),
    );

    expect(events).toEqual(["preflight", "pool", "query", "end"]);
    expect(message).not.toContain(querySecret);
    expect(message).not.toContain(shutdownSecret);
    expect(message).not.toContain(databaseUrl);
  });

  it("rejects a returned UUID that is not the requested exact user", async () => {
    const events: string[] = [];
    const pool: LocalAuthCleanupPool = {
      async end() {
        events.push("end");
      },
      async query() {
        events.push("query");
        return { rowCount: 1, rows: [{ id: otherUserId }] };
      },
    };

    await expect(
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(pool, events)),
    ).rejects.toThrow("com segurança");
  });
});
