import { describe, expect, it, vi } from "vitest";

import {
  cleanupLocalAuthUserWithDependencies,
  type LocalAuthCleanupClient,
  type LocalAuthCleanupDependencies,
} from "../helpers/local-auth-cleanup";

const email = "qa_worker_auth_cleanup@set-livre.local";
const userId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";
const otherUserId = "df74fb75-8611-48d8-b407-fc3be63ada21";
const databaseUrl = "postgresql://postgres:unit-secret@127.0.0.1:54322/postgres";

function dependenciesFor(client: LocalAuthCleanupClient, events: string[]) {
  const dependencies: LocalAuthCleanupDependencies = {
    async preflight() {
      events.push("preflight");
    },
    async withClient(operation) {
      events.push("client");
      return operation(client);
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
      expect(text).toContain("with authorization_fence as materialized");
      expect(text).toContain("pg_catalog.pg_advisory_xact_lock(");
      expect(text).toContain("'set-livre:backoffice-authorization'");
      expect(text).toContain("delete from auth.users using authorization_fence");
      expect(text).toContain("id = $1::uuid");
      expect(text).toContain("email = $2");
      expect(text).not.toMatch(/\blike\b|%/iu);
      expect(text).not.toContain(email);
      expect(text).not.toContain(userId);
      expect(values).toEqual([userId, email]);
      return { rowCount: 1, rows: [{ id: userId }] };
    });
    const client: LocalAuthCleanupClient = {
      query,
    };

    await expect(
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(client, events)),
    ).resolves.toBe(true);
    expect(events).toEqual(["preflight", "client", "query"]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("is idempotent only for the same exact UUID and email pair", async () => {
    const events: string[] = [];
    const client: LocalAuthCleanupClient = {
      async query() {
        events.push("query");
        return { rowCount: 0, rows: [] };
      },
    };

    await expect(
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(client, events)),
    ).resolves.toBe(false);
  });

  it.each([
    { email: "person@set-livre.local", userId },
    { email: "QA_worker_auth_cleanup@set-livre.local", userId },
    { email, userId: "not-a-uuid" },
  ])("rejects non-exact QA identity input before the preflight", async (input) => {
    const preflight = vi.fn(async () => undefined);
    const withClient = vi.fn(() => {
      throw new Error("client must not be acquired");
    });

    await expect(
      cleanupLocalAuthUserWithDependencies(input, {
        preflight,
        withClient,
      }),
    ).rejects.toThrow();
    expect(preflight).not.toHaveBeenCalled();
    expect(withClient).not.toHaveBeenCalled();
  });

  it("fails closed when the local database preflight is not valid", async () => {
    const preflightSecret = "preflight-database-secret";
    const withClient = vi.fn(() => {
      throw new Error("client must not be acquired");
    });
    const message = await capturedAsyncError(() =>
      cleanupLocalAuthUserWithDependencies(
        { email, userId },
        {
          preflight: async () => {
            throw new Error(preflightSecret);
          },
          withClient,
        },
      ),
    );

    expect(withClient).not.toHaveBeenCalled();
    expect(message).toContain("preflight");
    expect(message).not.toContain(preflightSecret);
    expect(message).not.toContain(databaseUrl);
  });

  it("redacts a query failure without leaking database or provider details", async () => {
    const events: string[] = [];
    const querySecret = "query-provider-secret";
    const client: LocalAuthCleanupClient = {
      async query() {
        events.push("query");
        throw new Error(querySecret);
      },
    };

    const message = await capturedAsyncError(() =>
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(client, events)),
    );

    expect(events).toEqual(["preflight", "client", "query"]);
    expect(message).not.toContain(querySecret);
    expect(message).not.toContain(databaseUrl);
  });

  it("rejects a returned UUID that is not the requested exact user", async () => {
    const events: string[] = [];
    const client: LocalAuthCleanupClient = {
      async query() {
        events.push("query");
        return { rowCount: 1, rows: [{ id: otherUserId }] };
      },
    };

    await expect(
      cleanupLocalAuthUserWithDependencies({ email, userId }, dependenciesFor(client, events)),
    ).rejects.toThrow("com segurança");
  });
});
