import { describe, expect, it } from "vitest";

import {
  createLocalPostgresClientConfig,
  executeLocalPostgresSql,
  redactLocalPostgresDiagnostics,
} from "../../scripts/local-postgres-command.mjs";

const adminDatabaseUrl = "postgresql://postgres:local-admin-password@127.0.0.1:54322/postgres";
const dalDatabaseUrl =
  "postgresql://app_runtime_local:local-runtime-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";

function expectedSessionObservation(configuration) {
  return {
    rows: [
      [
        configuration.options.includes("role=app_dal") ? "app_dal" : configuration.user,
        configuration.user,
        configuration.database,
        true,
        true,
        true,
      ],
    ],
  };
}

function recordingClient({ queryFailure, queryResult = { rows: [["ok"]] } } = {}) {
  const calls = [];
  let configuration;
  const createClient = (receivedConfiguration) => {
    configuration = receivedConfiguration;
    return {
      async connect() {
        calls.push(["connect"]);
      },
      async end() {
        calls.push(["end"]);
      },
      async query(query) {
        calls.push(["query", query]);
        if (calls.filter(([kind]) => kind === "query").length === 1) {
          return expectedSessionObservation(receivedConfiguration);
        }
        if (queryFailure !== undefined) {
          throw queryFailure;
        }
        return queryResult;
      },
    };
  };
  return { calls, createClient, configuration: () => configuration };
}

describe("local PostgreSQL client boundary", () => {
  it("pins loopback, identity and finite client/server timeouts without a connection string", () => {
    expect(createLocalPostgresClientConfig(adminDatabaseUrl)).toEqual({
      application_name: "set-livre-local-setup",
      client_encoding: "UTF8",
      connectionTimeoutMillis: 5_000,
      database: "postgres",
      host: "127.0.0.1",
      idle_in_transaction_session_timeout: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 1_000,
      lock_timeout: 15_000,
      options: "-c client_min_messages=warning",
      password: "local-admin-password",
      port: 54322,
      query_timeout: 120_000,
      ssl: false,
      sslnegotiation: "postgres",
      statement_timeout: 120_000,
      user: "postgres",
    });

    const dalConfiguration = createLocalPostgresClientConfig(dalDatabaseUrl, {
      assumeDalRole: true,
    });
    expect(dalConfiguration.options).toBe("-c client_min_messages=warning -c role=app_dal");
    expect(dalConfiguration).not.toHaveProperty("connectionString");
  });

  it("pins the numeric loopback destination and rejects every URL-side override", () => {
    for (const [databaseUrl, options] of [
      ["postgresql://postgres:secret@db.example.com:54322/postgres", undefined],
      ["postgresql://postgres:secret@localhost:54322/postgres", undefined],
      ["postgresql://postgres:secret@[::1]:54322/postgres", undefined],
      ["postgresql://postgres:secret@[::ffff:127.0.0.1]:54322/postgres", undefined],
      ["postgresql://postgres:secret@127.1:54322/postgres", undefined],
      ["postgresql://postgres:secret@0177.0.0.1:54322/postgres", undefined],
      ["postgresql://postgres:secret@0x7f000001:54322/postgres", undefined],
      ["postgresql://postgres:secret@2130706433:54322/postgres", undefined],
      ["postgresql://postgres:secret@127.000.000.001:54322/postgres", undefined],
      ["postgresql://postgres:secret@127.0.0.1.:54322/postgres", undefined],
      ["postgresql://postgres:secret@127%2e0%2e0%2e1:54322/postgres", undefined],
      ["postgresql://postgres:secret@127。0。0。1:54322/postgres", undefined],
      ["postgresql://postgres:secret@127.0.0.1:6543/postgres", undefined],
      ["postgresql://postgres:secret@127.0.0.1:54322/production", undefined],
      ["postgresql://postgres@127.0.0.1:54322/postgres", undefined],
      [`${adminDatabaseUrl}?hostaddr=127.0.0.2`, undefined],
      [dalDatabaseUrl, undefined],
      [`${dalDatabaseUrl}&sslmode=require`, { assumeDalRole: true }],
    ]) {
      expect(() => createLocalPostgresClientConfig(databaseUrl, options)).toThrow();
    }
  });

  it("proves session_user, current_user, database and server timeouts before SQL", async () => {
    const client = recordingClient({ queryResult: { rows: [["authoritative-result"]] } });
    const result = await executeLocalPostgresSql(dalDatabaseUrl, {
      assumeDalRole: true,
      createClient: client.createClient,
      sql: "select private.check_readiness('expected-head')",
    });

    expect(result).toEqual({ rows: [["authoritative-result"]] });
    expect(client.calls.map(([kind]) => kind)).toEqual(["connect", "query", "query", "end"]);
    expect(client.calls[1][1]).toMatchObject({
      query_timeout: 120_000,
      rowMode: "array",
      text: expect.stringContaining("current_user"),
    });
    expect(client.calls[1][1].text).toContain("statement_timeout");
    expect(client.calls[1][1].text).toContain("lock_timeout");
    expect(client.calls[1][1].text).toContain("idle_in_transaction_session_timeout");
    expect(client.calls[2][1]).toEqual({
      query_timeout: 120_000,
      rowMode: "array",
      text: "select private.check_readiness('expected-head')",
    });
  });

  it("removes inherited PG/PSQL overrides while constructing pg and restores the host", async () => {
    const originalPgHost = process.env.PGHOST;
    const originalPsqlRc = process.env.PSQLRC;
    const originalMixedCasePgService = process.env.pgSERVICE;
    process.env.PGHOST = "db.example.com";
    process.env.PSQLRC = "hostile-psqlrc";
    process.env.pgSERVICE = "hostile-service";
    let observedEnvironment;
    const client = recordingClient();

    try {
      await executeLocalPostgresSql(adminDatabaseUrl, {
        createClient(configuration) {
          observedEnvironment = {
            PGHOST: process.env.PGHOST,
            PSQLRC: process.env.PSQLRC,
            pgSERVICE: process.env.pgSERVICE,
          };
          return client.createClient(configuration);
        },
        sql: "select 1",
      });
      expect(observedEnvironment).toEqual({
        PGHOST: undefined,
        PSQLRC: undefined,
        pgSERVICE: undefined,
      });
      expect(process.env.PGHOST).toBe("db.example.com");
      expect(process.env.PSQLRC).toBe("hostile-psqlrc");
      expect(process.env.pgSERVICE).toBe("hostile-service");
    } finally {
      if (originalPgHost === undefined) {
        delete process.env.PGHOST;
      } else {
        process.env.PGHOST = originalPgHost;
      }
      if (originalPsqlRc === undefined) {
        delete process.env.PSQLRC;
      } else {
        process.env.PSQLRC = originalPsqlRc;
      }
      if (originalMixedCasePgService === undefined) {
        delete process.env.pgSERVICE;
      } else {
        process.env.pgSERVICE = originalMixedCasePgService;
      }
    }
  });

  it("fails closed before operational SQL when the effective role contract diverges", async () => {
    let queryCalls = 0;
    const createClient = () => ({
      async connect() {},
      async end() {},
      async query() {
        queryCalls += 1;
        return { rows: [["postgres", "app_runtime_local", "postgres", true, true, true]] };
      },
    });

    await expect(
      executeLocalPostgresSql(dalDatabaseUrl, {
        assumeDalRole: true,
        createClient,
        sql: "select dangerous_operation()",
      }),
    ).rejects.toThrow("não comprovou destino, identidade, role e timeouts");
    expect(queryCalls).toBe(1);
  });

  it("redacts URLs and every bootstrap secret without retaining the original error", async () => {
    const adminPassword = "admin-password-sentinel";
    const runtimePassword = "runtime-password-sentinel";
    const e2eDatabaseMarker = "e2e-marker-sentinel";
    const databaseUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:54322/postgres`;
    const queryFailure = Object.assign(new Error(`falha controlada com ${runtimePassword}`), {
      detail: `postgresql://postgres:${adminPassword}@127.0.0.1:54322/postgres`,
      where: `COMMENT set-livre-e2e:${e2eDatabaseMarker}`,
    });
    const client = recordingClient({ queryFailure });

    let failure;
    try {
      await executeLocalPostgresSql(databaseUrl, {
        createClient: client.createClient,
        redactions: [runtimePassword, e2eDatabaseMarker],
        sql: "select 1",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(queryFailure);
    expect(failure).not.toHaveProperty("cause");
    expect(failure.message).toContain("postgresql://postgres:[REDACTED]@127.0.0.1");
    expect(failure.message).not.toContain(adminPassword);
    expect(failure.message).not.toContain(runtimePassword);
    expect(failure.message).not.toContain(e2eDatabaseMarker);
    expect(client.calls.at(-1)).toEqual(["end"]);
  });

  it("keeps only the last safe diagnostic lines", () => {
    const diagnostics = redactLocalPostgresDiagnostics(
      { message: Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n") },
      [],
    );
    expect(diagnostics.split("\n")).toHaveLength(12);
    expect(diagnostics).not.toContain("line-0\n");
    expect(diagnostics).toContain("line-19");
  });
});
