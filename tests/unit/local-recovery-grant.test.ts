import { describe, expect, it, vi } from "vitest";

import {
  assertExactLocalRecoverySessionClosedWithDependencies,
  expireExactLocalRecoveryGrantWithDependencies,
  type LocalRecoveryGrantDependencies,
  type LocalRecoveryGrantPool,
} from "../helpers/local-recovery-grant";

const email = "qa_f002_recovery_expiry@example.test";
const userId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";
const databaseUrl = "postgresql://postgres:unit-secret@127.0.0.1:54322/postgres";

function dependenciesFor(pool: LocalRecoveryGrantPool, events: string[]) {
  const dependencies: LocalRecoveryGrantDependencies = {
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

describe("exact local recovery grant expiry", () => {
  it("runs the local preflight before one parameterized exact expiration", async () => {
    const events: string[] = [];
    const query = vi.fn(async (text: string, values: readonly [string, string]) => {
      events.push("query");
      expect(text).toContain("update private.identity_recovery_grants");
      expect(text).toContain("candidate_count.exact_count = 1");
      expect(text).toContain("recovery_grant.user_id = $1::uuid");
      expect(text).toContain("auth_user.email = $2");
      expect(text).toContain("recovery_session.closed_at is null");
      expect(text).toContain("auth.sessions as auth_session");
      expect(text).toContain("recovery_grant.claim_attempt_id is null");
      expect(text).toContain("returning true as expired");
      expect(text).not.toContain(email);
      expect(text).not.toContain(userId);
      expect(values).toEqual([userId, email]);
      return { rowCount: 1, rows: [{ expired: true }] };
    });
    const pool: LocalRecoveryGrantPool = {
      async end() {
        events.push("end");
      },
      query,
    };

    await expect(
      expireExactLocalRecoveryGrantWithDependencies(
        { email, userId },
        dependenciesFor(pool, events),
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["preflight", "pool", "query", "end"]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    { rowCount: 0, rows: [] },
    { rowCount: 2, rows: [{ expired: true }, { expired: true }] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [{ expired: false }] },
  ])("fails closed when one exact active grant was not proven", async (result) => {
    const events: string[] = [];
    const pool: LocalRecoveryGrantPool = {
      async end() {
        events.push("end");
      },
      async query() {
        events.push("query");
        return result;
      },
    };

    await expect(
      expireExactLocalRecoveryGrantWithDependencies(
        { email, userId },
        dependenciesFor(pool, events),
      ),
    ).rejects.toThrow("com segurança");
    expect(events).toEqual(["preflight", "pool", "query", "end"]);
  });

  it.each([
    { email: "person@example.test", userId },
    { email: "QA_f002_recovery_expiry@example.test", userId },
    { email, userId: "not-a-uuid" },
  ])("rejects non-exact QA inputs before the database preflight", async (input) => {
    const preflight = vi.fn(async () => undefined);
    const createPool = vi.fn(() => {
      throw new Error("pool must not be created");
    });

    await expect(
      expireExactLocalRecoveryGrantWithDependencies(input, {
        adminDatabaseUrl: databaseUrl,
        createPool,
        preflight,
      }),
    ).rejects.toThrow();
    expect(preflight).not.toHaveBeenCalled();
    expect(createPool).not.toHaveBeenCalled();
  });

  it("redacts a failed local preflight before creating a pool", async () => {
    const preflightSecret = "private-preflight-detail";
    const createPool = vi.fn(() => {
      throw new Error("pool must not be created");
    });
    const message = await capturedAsyncError(() =>
      expireExactLocalRecoveryGrantWithDependencies(
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

  it("redacts query and shutdown failures while still closing the pool", async () => {
    const events: string[] = [];
    const querySecret = "private-query-detail";
    const shutdownSecret = "private-shutdown-detail";
    const pool: LocalRecoveryGrantPool = {
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
      expireExactLocalRecoveryGrantWithDependencies(
        { email, userId },
        dependenciesFor(pool, events),
      ),
    );

    expect(events).toEqual(["preflight", "pool", "query", "end"]);
    expect(message).not.toContain(querySecret);
    expect(message).not.toContain(shutdownSecret);
    expect(message).not.toContain(databaseUrl);
    expect(message).not.toContain(email);
    expect(message).not.toContain(userId);
  });
});

describe("exact local recovery session closure proof", () => {
  it("proves historical tombstones with no open binding, canonical session or grant", async () => {
    const events: string[] = [];
    const query = vi.fn(async (text: string, values: readonly [string, string]) => {
      events.push("query");
      expect(text).toContain("private.identity_recovery_sessions");
      expect(text).toContain("private.identity_recovery_grants");
      expect(text).toContain("auth.sessions as auth_session");
      expect(text).toContain("auth_user.id = $1::uuid");
      expect(text).toContain("auth_user.email = $2");
      expect(text).not.toContain(email);
      expect(text).not.toContain(userId);
      expect(values).toEqual([userId, email]);
      return {
        rowCount: 1,
        rows: [
          {
            exact_user_count: 1,
            grant_count: 0,
            historical_binding_count: 2,
            linked_auth_session_count: 0,
            open_binding_count: 0,
          },
        ],
      };
    });
    const pool: LocalRecoveryGrantPool = {
      async end() {
        events.push("end");
      },
      query,
    };

    await expect(
      assertExactLocalRecoverySessionClosedWithDependencies(
        { email, userId },
        dependenciesFor(pool, events),
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["preflight", "pool", "query", "end"]);
  });

  it.each([
    {
      exact_user_count: 0,
      grant_count: 0,
      historical_binding_count: 1,
      linked_auth_session_count: 0,
      open_binding_count: 0,
    },
    {
      exact_user_count: 1,
      grant_count: 0,
      historical_binding_count: 0,
      linked_auth_session_count: 0,
      open_binding_count: 0,
    },
    {
      exact_user_count: 1,
      grant_count: 0,
      historical_binding_count: 1,
      linked_auth_session_count: 0,
      open_binding_count: 1,
    },
    {
      exact_user_count: 1,
      grant_count: 0,
      historical_binding_count: 1,
      linked_auth_session_count: 1,
      open_binding_count: 0,
    },
    {
      exact_user_count: 1,
      grant_count: 1,
      historical_binding_count: 1,
      linked_auth_session_count: 0,
      open_binding_count: 0,
    },
  ])("fails closed when the structural post-condition is not exact", async (row) => {
    const events: string[] = [];
    const pool: LocalRecoveryGrantPool = {
      async end() {
        events.push("end");
      },
      async query() {
        events.push("query");
        return { rowCount: 1, rows: [row] };
      },
    };

    await expect(
      assertExactLocalRecoverySessionClosedWithDependencies(
        { email, userId },
        dependenciesFor(pool, events),
      ),
    ).rejects.toThrow("encerramento");
    expect(events).toEqual(["preflight", "pool", "query", "end"]);
  });

  it("redacts query details while still closing the pool", async () => {
    const events: string[] = [];
    const privateDetail = "private-session-query-detail";
    const pool: LocalRecoveryGrantPool = {
      async end() {
        events.push("end");
      },
      async query() {
        events.push("query");
        throw new Error(privateDetail);
      },
    };

    const message = await capturedAsyncError(() =>
      assertExactLocalRecoverySessionClosedWithDependencies(
        { email, userId },
        dependenciesFor(pool, events),
      ),
    );

    expect(events).toEqual(["preflight", "pool", "query", "end"]);
    expect(message).not.toContain(privateDetail);
    expect(message).not.toContain(email);
    expect(message).not.toContain(userId);
    expect(message).not.toContain(databaseUrl);
  });
});
