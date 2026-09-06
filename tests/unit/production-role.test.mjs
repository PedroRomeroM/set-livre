import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { databaseMigrationHead } from "../../packages/contracts/src/database-contract.ts";
import {
  assertProductionDeploymentContract,
  assertSupabasePublishableKey,
  assertSupabaseSecretKey,
  forceProductionRoleDisabled,
  provisionProductionRole,
  productionRoleActivationMode,
  productionRoleConnections,
  verifyProductionDeploymentContract,
  verifyProductionRuntimeCredentialBeforeMigrations,
} from "../../scripts/provision-production-role.mjs";

const projectRef = "oirvvnojgkzdppkdvhej";
const runtimeUrl =
  "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:runtime%23secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal";
const restrictedRuntimeRole = Object.freeze({
  bypassRls: false,
  canLogin: true,
  connectionLimit: 10,
  createDatabase: false,
  createRole: false,
  hasPassword: true,
  inherit: false,
  replication: false,
  roleName: "app_runtime_production",
  settingsAreEmpty: true,
  superuser: false,
  validUntilIsInfinite: true,
});
const restrictedAppDalRole = Object.freeze({
  ...restrictedRuntimeRole,
  canLogin: false,
  connectionLimit: -1,
  hasPassword: false,
  roleName: "app_dal",
  settingsAreEmpty: true,
});
const initialRuntimeRole = Object.freeze({
  ...restrictedRuntimeRole,
  canLogin: false,
  hasPassword: false,
  settingsAreEmpty: true,
});
const expectedRuntimeMembership = Object.freeze({
  adminOption: false,
  inheritOption: false,
  roleName: "app_dal",
  setOption: true,
});
const expectedRuntimeMember = Object.freeze({
  adminOption: true,
  inheritOption: false,
  roleName: "postgres",
  setOption: false,
});

function productionPreflightAdminQuery({
  applicationObjectCount = 0,
  currentBoundary = {
    currentMigrationHead: "20260828174500",
    managedBoundariesReady: true,
    ready: true,
  },
  currentBoundaryError,
  observedMigrationHead = currentBoundary.currentMigrationHead,
  memberships = [expectedRuntimeMembership],
  migrationCount = 0,
  migrationTable = null,
  roles = [restrictedAppDalRole, restrictedRuntimeRole],
  runtimeMembers = [expectedRuntimeMember],
} = {}) {
  return vi.fn(async (statement) => {
    const sql = String(statement);
    if (sql.includes("where role.rolname in ('app_dal', 'app_runtime_production')")) {
      return { rowCount: roles.length, rows: roles };
    }
    if (sql.includes("pg_catalog.to_regclass")) {
      return { rowCount: 1, rows: [{ migrationTable }] };
    }
    if (sql.includes('pg_catalog.count(*)::integer as "migrationCount"')) {
      return {
        rowCount: 1,
        rows: [
          {
            currentMigrationHead: migrationCount === 0 ? null : "20260828174500",
            migrationCount,
          },
        ],
      };
    }
    if (sql.includes('pg_catalog.count(*)::integer as "applicationObjectCount"')) {
      return { rowCount: 1, rows: [{ applicationObjectCount }] };
    }
    if (sql.includes("where member.rolname = 'app_runtime_production'")) {
      return { rowCount: memberships.length, rows: memberships };
    }
    if (sql.includes("where granted.rolname = 'app_runtime_production'")) {
      return { rowCount: runtimeMembers.length, rows: runtimeMembers };
    }
    if (sql.includes('pg_catalog.max(migration.version)::text as "currentMigrationHead"')) {
      return { rowCount: 1, rows: [{ currentMigrationHead: observedMigrationHead }] };
    }
    if (
      sql.includes("private.check_deployment_structure(current_head.version)") ||
      sql.includes("private.check_readiness(current_head.version)")
    ) {
      if (currentBoundaryError !== undefined) throw currentBoundaryError;
      return { rowCount: 1, rows: [currentBoundary] };
    }
    throw new Error("consulta administrativa inesperada no preflight de teste");
  });
}

function productionProvisioningAdminQuery({
  databaseReadiness = { migrationHeadIsCurrent: true, ready: true },
  roles = [restrictedAppDalRole, initialRuntimeRole],
} = {}) {
  return vi.fn(async (statement) => {
    const sql = String(statement);
    if (sql.includes("where role.rolname in ('app_dal', 'app_runtime_production')")) {
      return { rowCount: roles.length, rows: roles };
    }
    if (sql.includes("where member.rolname = 'app_runtime_production'")) {
      return { rowCount: 1, rows: [expectedRuntimeMembership] };
    }
    if (sql.includes("where granted.rolname = 'app_runtime_production'")) {
      return { rowCount: 1, rows: [expectedRuntimeMember] };
    }
    if (sql.includes("select private.managed_runtime_boundaries_are_ready() as ready")) {
      return { rowCount: 1, rows: [{ ready: true }] };
    }
    if (sql.includes("private.check_readiness($1::text) as ready")) {
      return { rowCount: 1, rows: [databaseReadiness] };
    }
    if (sql.includes("pg_catalog.format('alter role app_runtime_production login password")) {
      return {
        rowCount: 1,
        rows: [{ statement: "alter role app_runtime_production login password 'runtime-secret'" }],
      };
    }
    return { rowCount: null, rows: [] };
  });
}

describe("production role provisioning", () => {
  const fixedCoordinates = {
    PRODUCTION_BACKOFFICE_APP_URL: "http://127.0.0.1:3001",
    PRODUCTION_PUBLIC_APP_URL: "https://147.15.97.227",
    PRODUCTION_SUPABASE_URL: "https://oirvvnojgkzdppkdvhej.supabase.co",
    PRODUCTION_VM_HOST: "147.15.97.227",
    PRD_SUPABASE_SECRET_KEY: "sb_secret_production-contract-key",
  };

  it("derives explicit TLS admin and restricted runtime connections", () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });

    expect(connections.admin).toMatchObject({
      database: "postgres",
      host: "aws-0-sa-east-1.pooler.supabase.com",
      password: "admin-secret",
      port: 5432,
      ssl: { rejectUnauthorized: true },
      user: `postgres.${projectRef}`,
    });
    expect(connections.runtime).toMatchObject({
      options: "-c role=app_dal",
      password: "runtime#secret",
      user: `app_runtime_production.${projectRef}`,
    });
  });

  it("rejects project drift and non-production runtime identities", () => {
    expect(() =>
      productionRoleConnections({
        PRD_DATABASE_URL_APP_DAL: runtimeUrl,
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      }),
    ).toThrow("projeto Set Livre");

    expect(() =>
      productionRoleConnections({
        PRD_DATABASE_URL_APP_DAL: runtimeUrl.replace(
          "app_runtime_production",
          "app_runtime_preview",
        ),
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: projectRef,
      }),
    ).toThrow("identidade e as coordenadas canônicas");

    expect(() =>
      productionRoleConnections({
        PRD_DATABASE_URL_APP_DAL: runtimeUrl.replace(
          "aws-0-sa-east-1.pooler.supabase.com",
          "aws-0-us-east-1.pooler.supabase.com",
        ),
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: projectRef,
      }),
    ).toThrow("identidade e as coordenadas canônicas");
  });

  it("fails closed when a public production coordinate drifts", () => {
    const environment = {
      ...fixedCoordinates,
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      PRD_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-contract",
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    };
    expect(() => assertProductionDeploymentContract(environment)).not.toThrow();
    expect(() =>
      assertProductionDeploymentContract({
        ...environment,
        PRODUCTION_PUBLIC_APP_URL: "https://wrong.example",
      }),
    ).toThrow("diverge");
  });

  it("accepts only a Supabase publishable key and rejects privileged key classes", () => {
    const serviceRoleJwt = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: "supabase", role: "service_role" })).toString("base64url"),
      "synthetic-signature",
    ].join(".");

    expect(() => assertSupabasePublishableKey("sb_publishable_test-contract")).not.toThrow();
    expect(() => assertSupabasePublishableKey("sb_secret_synthetic-contract")).toThrow(
      "chave privilegiada",
    );
    expect(() => assertSupabasePublishableKey(serviceRoleJwt)).toThrow("chave privilegiada");
    expect(() => assertSupabasePublishableKey("synthetic-anon-value")).toThrow("formato inválido");
  });

  it("accepts only the dedicated Supabase secret-key class for trusted server operations", () => {
    expect(() => assertSupabaseSecretKey("sb_secret_production-contract-key")).not.toThrow();
    expect(() => assertSupabaseSecretKey("sb_publishable_public-contract-key")).toThrow(
      "secret dedicada",
    );
    expect(() => assertSupabaseSecretKey("synthetic-secret")).toThrow("formato inválido");
    expect(() => assertSupabaseSecretKey("a.b.c")).toThrow("secret dedicada");
  });

  it("confirms the configured publishable key against the exact production project", async () => {
    const publishableKey = "sb_publishable_project-contract";
    const environment = {
      ...fixedCoordinates,
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      PRD_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    };
    const fetchImplementation = vi.fn(async () =>
      Response.json({ disable_signup: false, external: {} }, { status: 200 }),
    );
    const clients = [];
    const createClient = vi.fn((configuration) => {
      const admin = configuration.user === `postgres.${projectRef}`;
      const client = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: admin
          ? productionPreflightAdminQuery()
          : vi.fn(async () => ({
              rowCount: 1,
              rows: [
                {
                  currentRole: "app_dal",
                  ready: true,
                  sessionRole: "app_runtime_production",
                },
              ],
            })),
      };
      clients.push(client);
      return client;
    });

    await expect(
      verifyProductionDeploymentContract(environment, { createClient, fetchImplementation }),
    ).resolves.toBeDefined();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, options] = fetchImplementation.mock.calls[0];
    expect(url).toBe("https://oirvvnojgkzdppkdvhej.supabase.co/auth/v1/settings");
    expect(options).toMatchObject({
      cache: "no-store",
      headers: {
        Accept: "application/json",
        apikey: publishableKey,
      },
      method: "GET",
      redirect: "error",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient.mock.calls[1][0]).toMatchObject({
      password: "runtime#secret",
      user: `app_runtime_production.${projectRef}`,
    });
    expect(clients[1].query).toHaveBeenCalledWith(
      expect.stringContaining("private.check_runtime_readiness($1)"),
      ["app_runtime_production"],
    );
  });

  it("rejects unsafe raw URL characters before production network or database access", async () => {
    for (const [unsafeUrl, message] of [
      [`${runtimeUrl}\n`, "caractere de controle não autorizado"],
      [runtimeUrl.replace(":runtime%23secret@", ":runtime'secret@"), "exige percent-encoding"],
    ]) {
      const fetchImplementation = vi.fn();
      const createClient = vi.fn();
      const environment = {
        ...fixedCoordinates,
        PRD_DATABASE_URL_APP_DAL: unsafeUrl,
        PRD_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_project-contract",
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: projectRef,
      };

      await expect(
        verifyProductionDeploymentContract(environment, { createClient, fetchImplementation }),
      ).rejects.toThrow(message);
      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it("allows absent roles only with an empty or not-yet-created migration ledger", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });
    for (const migrationTable of [null, "supabase_migrations.schema_migrations"]) {
      const query = productionPreflightAdminQuery({ migrationTable, roles: [] });
      const createClient = vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query,
      }));

      await expect(
        verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
      ).resolves.toBeUndefined();
      expect(createClient).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledTimes(migrationTable === null ? 3 : 4);
    }
  });

  it("rejects an absent migration ledger when application objects remain", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });
    const query = productionPreflightAdminQuery({
      applicationObjectCount: 1,
      migrationTable: null,
      roles: [],
    });
    const createClient = vi.fn(() => ({
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query,
    }));

    let failure;
    try {
      await verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      expect.objectContaining({
        message: "Não foi possível validar a role de produção antes das migrations.",
        cause: expect.objectContaining({
          message:
            "Roles ausentes exigem banco sem schemas ou objetos de aplicação antes do bootstrap.",
        }),
      }),
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("pg_catalog.pg_depend"))).toBe(
      true,
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("dependency.deptype = 'e'"))).toBe(
      true,
    );
  });

  it("rejects absent production roles after any migration was recorded", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });
    const query = productionPreflightAdminQuery({
      migrationCount: 1,
      migrationTable: "supabase_migrations.schema_migrations",
      roles: [],
    });
    const createClient = vi.fn(() => ({
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query,
    }));
    let failure;

    try {
      await verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.cause).toEqual(
      expect.objectContaining({
        message: "Roles ausentes só são permitidas antes da primeira migration de produção.",
      }),
    );
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["20260905190840", "check_readiness", "check_deployment_structure"],
    ["20260906051637", "check_deployment_structure", "check_readiness"],
    ["20260907000000", "check_deployment_structure", "check_readiness"],
  ])(
    "selects the deployed readiness contract for head %s as admin",
    async (head, expectedFunction, forbiddenFunction) => {
      const connections = productionRoleConnections({
        PRD_DATABASE_URL_APP_DAL: runtimeUrl,
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: projectRef,
      });
      const query = productionPreflightAdminQuery({
        currentBoundary: { currentMigrationHead: head, managedBoundariesReady: true, ready: true },
        roles: [restrictedAppDalRole, initialRuntimeRole],
      });
      const createClient = vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query,
      }));

      await expect(
        verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
      ).resolves.toBeUndefined();
      expect(createClient).toHaveBeenCalledOnce();
      expect(createClient).toHaveBeenCalledWith(connections.admin);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("with current_head as"));
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(`private.${expectedFunction}(current_head.version)`),
      );
      expect(query.mock.calls.flat().join(" ")).not.toContain(`private.${forbiddenFunction}(`);
      const statements = query.mock.calls.map(([statement]) => String(statement));
      const headRead = statements.findIndex((sql) =>
        sql.includes('pg_catalog.max(migration.version)::text as "currentMigrationHead"'),
      );
      expect(headRead).toBeGreaterThan(-1);
      expect(headRead).toBeLessThan(
        statements.findIndex((sql) => sql.includes("with current_head as")),
      );
    },
  );

  it("rejects a head change between contract selection and boundary verification", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });
    const admin = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: productionPreflightAdminQuery({
        observedMigrationHead: "20260905190840",
        currentBoundary: {
          currentMigrationHead: "20260906051637",
          managedBoundariesReady: true,
          ready: true,
        },
      }),
    };
    const createClient = vi.fn(() => admin);
    await expect(
      verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "A fronteira DAL implantada diverge do seu migration head atual.",
      }),
    });
    expect(createClient).toHaveBeenCalledOnce();
    expect(admin.end).toHaveBeenCalledOnce();
  });

  it.each(["42883", "42501", "XX000", "08006"])(
    "propagates deployment structure failure %s without fallback or runtime access",
    async (code) => {
      const connections = productionRoleConnections({
        PRD_DATABASE_URL_APP_DAL: runtimeUrl,
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: projectRef,
      });
      const failure = Object.assign(new Error("deployment structure check failed"), { code });
      const admin = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: productionPreflightAdminQuery({
          currentBoundaryError: failure,
          currentBoundary: {
            currentMigrationHead: "20260907000000",
            managedBoundariesReady: true,
            ready: true,
          },
        }),
      };
      const createClient = vi.fn(() => admin);
      await expect(
        verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
      ).rejects.toMatchObject({
        message: "Não foi possível validar a role de produção antes das migrations.",
        cause: failure,
      });
      expect(createClient).toHaveBeenCalledOnce();
      expect(createClient).toHaveBeenCalledWith(connections.admin);
      expect(admin.end).toHaveBeenCalledOnce();
      expect(admin.query.mock.calls.flat().join(" ")).not.toContain("private.check_readiness(");
    },
  );

  it.each(["20260905190840", "20260906051637", "20260907000000"])(
    "rejects a stale active runtime credential before migrations at head %s",
    async (head) => {
      const connections = productionRoleConnections({
        PRD_DATABASE_URL_APP_DAL: runtimeUrl,
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: projectRef,
      });
      const clients = [];
      const createClient = vi.fn(() => {
        const clientIndex = clients.length;
        const client = {
          connect: vi.fn(async () => {
            if (clientIndex === 1) throw new Error("password authentication failed");
          }),
          end: vi.fn(async () => undefined),
          query:
            clientIndex === 0
              ? productionPreflightAdminQuery({
                  currentBoundary: {
                    currentMigrationHead: head,
                    managedBoundariesReady: true,
                    ready: true,
                  },
                })
              : vi.fn(async () => ({
                  rowCount: 1,
                  rows: [
                    {
                      currentRole: "app_dal",
                      ready: true,
                      sessionRole: "app_runtime_production",
                    },
                  ],
                })),
        };
        clients.push(client);
        return client;
      });

      await expect(
        verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
      ).rejects.toThrow("credencial runtime ativa não autenticou antes das migrations");
      expect(clients).toHaveLength(2);
      expect(clients[0].end).toHaveBeenCalledOnce();
      expect(clients[1].end).toHaveBeenCalledOnce();
    },
  );

  it("rejects an active credential that cannot prove the exact restricted runtime", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });
    const clients = [];
    const createClient = vi.fn(() => {
      const clientIndex = clients.length;
      const client = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query:
          clientIndex === 0
            ? productionPreflightAdminQuery()
            : vi.fn(async () => ({
                rowCount: 1,
                rows: [
                  {
                    currentRole: "app_dal",
                    ready: false,
                    sessionRole: "app_runtime_production",
                  },
                ],
              })),
      };
      clients.push(client);
      return client;
    });

    await expect(
      verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
    ).rejects.toThrow("credencial runtime ativa não autenticou antes das migrations");
    expect(clients).toHaveLength(2);
    expect(clients[1].query).toHaveBeenCalledWith(
      expect.stringContaining("private.check_runtime_readiness($1)"),
      ["app_runtime_production"],
    );
  });

  it("rejects active runtime privilege or membership drift before migrations", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });
    const cases = [
      {
        options: {
          roles: [restrictedAppDalRole, { ...restrictedRuntimeRole, createDatabase: true }],
        },
        cause: "atributos restritos",
      },
      {
        options: {
          roles: [restrictedAppDalRole, { ...restrictedRuntimeRole, superuser: undefined }],
        },
        cause: "atributos restritos",
      },
      {
        options: {
          roles: [{ ...restrictedAppDalRole, canLogin: true }, restrictedRuntimeRole],
        },
        cause: "role DAL",
      },
      {
        options: {
          roles: [{ ...restrictedAppDalRole, createRole: true }, restrictedRuntimeRole],
        },
        cause: "role DAL",
      },
      {
        options: { roles: [restrictedRuntimeRole] },
        cause: "parcial ou ambíguo",
      },
      {
        options: {
          memberships: [
            expectedRuntimeMembership,
            { ...expectedRuntimeMembership, roleName: "unexpected_role" },
          ],
        },
        cause: "membership inesperado",
      },
      {
        options: {
          runtimeMembers: [
            expectedRuntimeMember,
            { ...expectedRuntimeMember, adminOption: false, roleName: "unexpected_member" },
          ],
        },
        cause: "identidade inesperada",
      },
      {
        options: {
          currentBoundary: {
            currentMigrationHead: "20260828174500",
            managedBoundariesReady: false,
            ready: true,
          },
        },
        cause: "fronteira DAL implantada",
      },
      {
        options: {
          currentBoundary: {
            currentMigrationHead: "20260828174500",
            managedBoundariesReady: true,
            ready: false,
          },
        },
        cause: "fronteira DAL implantada",
      },
      {
        options: {
          currentBoundary: {
            currentMigrationHead: "invalid-head",
            managedBoundariesReady: true,
            ready: true,
          },
        },
        cause: "fronteira DAL implantada",
      },
    ];

    for (const scenario of cases) {
      const createClient = vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: productionPreflightAdminQuery(scenario.options),
      }));
      let failure;
      try {
        await verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain("antes das migrations");
      expect(failure?.cause).toBeInstanceOf(Error);
      expect(failure?.cause?.message).toContain(scenario.cause);
      expect(createClient).toHaveBeenCalledOnce();
    }
  });

  it("fails closed for a foreign key, invalid payload, redirect, or network failure", async () => {
    const publishableKey = "sb_publishable_foreign-contract";
    const environment = {
      ...fixedCoordinates,
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      PRD_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    };
    const verifyWith = (fetchImplementation) =>
      verifyProductionDeploymentContract(environment, { fetchImplementation });

    await expect(verifyWith(async () => new Response(null, { status: 401 }))).rejects.toThrow(
      "recusou a chave publishable (401)",
    );
    await expect(verifyWith(async () => new Response(null, { status: 503 }))).rejects.toThrow(
      "recusou a chave publishable (503)",
    );
    await expect(verifyWith(async () => new Response("not-json", { status: 200 }))).rejects.toThrow(
      "payload inválido",
    );
    await expect(verifyWith(async () => Response.json({ error: "unexpected" }))).rejects.toThrow(
      "contrato inválido",
    );
    await expect(
      verifyWith(async () => {
        throw new TypeError("redirect blocked");
      }),
    ).rejects.toThrow("Não foi possível validar");
    await expect(
      verifyWith(async () => {
        throw new Error(`network failure for ${publishableKey}`);
      }),
    ).rejects.not.toThrow(publishableKey);
  });

  it("proves the host, public HTTPS path, and exact release before migrations", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const deployJob = workflow.slice(workflow.indexOf("  deploy:"));
    const orderedSteps = [
      "- name: Validate fixed production contract",
      "- name: Authenticate Oracle deployment path",
      "- name: Verify public HTTPS entrypoint",
      "- name: Prepare and identify ephemeral runtime environments",
      "- name: Inspect exact immutable release on Oracle VM",
      "- name: Build web release",
      "- name: Build backoffice release",
      "- name: Package immutable release",
      "- name: Stage and verify release on Oracle VM",
      "- name: Select exact verified release",
      "- name: Apply forward-only Supabase migrations",
      "- name: Deploy immutable media cleanup candidate",
      "- name: Run immutable media cleanup canary",
      "- name: Activate and verify the restricted production role",
      "- name: Activate staged release on Oracle VM",
      "- name: Verify public web health",
      "- name: Prune unreferenced media cleanup functions",
    ];
    const positions = orderedSteps.map((step) => deployJob.indexOf(step));
    const preflight = positions[0];
    const sshAuthentication = positions[1];
    const publicHttps = positions[2];
    const runtimeEnvironment = positions[3];
    const releaseInspection = positions[4];
    const webBuild = positions[5];
    const staging = positions[8];
    const releaseSelection = positions[9];
    const migrations = positions[10];
    const canary = positions[12];
    const roleActivation = positions[13];
    const activation = positions[14];
    const publicHealth = positions[15];
    const pruning = positions[16];

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(deployJob.slice(preflight, sshAuthentication)).toContain(
      "NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/ops/certificates/supabase-root-2021-ca.crt",
    );
    const sshProbe = deployJob.slice(sshAuthentication, publicHttps);
    expect(sshProbe).toContain('[[ "$known_host" == "$PRODUCTION_VM_HOST" ]]');
    expect(sshProbe).toContain('UserKnownHostsFile="$HOME/.ssh/known_hosts"');
    expect(sshProbe).toContain('"deploy-setlivre@${PRODUCTION_VM_HOST}" preflight');
    expect(sshProbe).toContain('[[ "$deployment_probe" == "set-livre-deploy-ready-v12" ]]');
    const httpsProbe = deployJob.slice(publicHttps, runtimeEnvironment);
    expect(httpsProbe).toContain("--proto '=https'");
    expect(httpsProbe).toContain("--tlsv1.2");
    expect(httpsProbe).toContain('"$status" == 200');
    expect(httpsProbe).toContain("User-agent: *\\nDisallow: /");
    expect(httpsProbe).toContain("X-Robots-Tag: noindex, nofollow, noarchive, nosnippet");
    const runtimeStep = deployJob.slice(runtimeEnvironment, releaseInspection);
    expect(runtimeStep).toContain(
      "BACKOFFICE_RUNTIME_UNLOCK_KEY: ${{ secrets.BACKOFFICE_RUNTIME_UNLOCK_KEY }}",
    );
    expect(runtimeStep).toContain('[[ "$BACKOFFICE_RUNTIME_UNLOCK_KEY" =~ ^[A-Za-z0-9_-]{43}$ ]]');
    expect(runtimeStep).toContain("printf 'BACKOFFICE_RUNTIME_UNLOCK_KEY=%s\\n'");
    expect(runtimeStep).toContain("runtime_digest");
    expect(runtimeStep).toContain("sha256sum");
    expect(runtimeStep).toContain('echo "digest=$runtime_digest" >> "$GITHUB_OUTPUT"');
    const inspectionStep = deployJob.slice(releaseInspection, webBuild);
    expect(inspectionStep).toContain('"inspect ${GITHUB_SHA} ${RUNTIME_ENVIRONMENT_DIGEST}"');
    expect(inspectionStep).toContain('echo "reuse=true" >> "$GITHUB_OUTPUT"');
    expect(inspectionStep).toContain('echo "reuse=false" >> "$GITHUB_OUTPUT"');
    const buildAndStage = deployJob.slice(webBuild, releaseSelection);
    expect(
      buildAndStage.match(/if: steps\.existing_release\.outputs\.reuse != 'true'/gu),
    ).toHaveLength(4);
    expect(deployJob.indexOf("npm run build:web")).toBeLessThan(migrations);
    expect(deployJob.indexOf("npm run build:backoffice")).toBeLessThan(migrations);
    expect(deployJob.indexOf("npm run release")).toBeLessThan(migrations);
    expect(deployJob.indexOf("cmp --silent")).toBeLessThan(migrations);
    expect(deployJob.indexOf("write_environment")).toBeLessThan(releaseInspection);
    const stagingStep = deployJob.slice(staging, migrations);
    expect(stagingStep).toContain('"upload-release ${GITHUB_SHA}"');
    expect(stagingStep).toContain('"upload-web-environment ${GITHUB_SHA}"');
    expect(stagingStep).toContain('"upload-backoffice-environment ${GITHUB_SHA}"');
    expect(stagingStep).toContain(
      '"stage ${GITHUB_SHA} ${CHECKSUM} ${RUNTIME_ENVIRONMENT_DIGEST}"',
    );
    const selectionStep = deployJob.slice(releaseSelection, migrations);
    expect(selectionStep).toContain('checksum="$EXISTING_CHECKSUM"');
    expect(selectionStep).toContain('checksum="$BUILT_CHECKSUM"');
    const activationStep = deployJob.slice(activation, publicHealth);
    expect(activationStep).toContain(
      '"activate ${GITHUB_SHA} ${CHECKSUM} ${RUNTIME_ENVIRONMENT_DIGEST}"',
    );
    expect(activationStep).toContain("CHECKSUM: ${{ steps.selected_release.outputs.checksum }}");
    expect(activationStep).not.toContain("upload-release");
    expect(deployJob).not.toContain("Read active public release for cleanup retention");
    expect(deployJob).not.toContain("ACTIVE_PUBLIC_RELEASE_SHA");
    const canaryStep = deployJob.slice(canary, roleActivation);
    expect(canaryStep).toContain("MEDIA_CLEANUP_FUNCTION_SLUG:");
    expect(canaryStep).toContain("npm run production:media-cleanup");
    expect(canaryStep).not.toContain("--prune-functions");
    const pruningStep = deployJob.slice(
      pruning,
      deployJob.indexOf("- name: Remove ephemeral runtime credentials", pruning),
    );
    expect(pruningStep).toContain('"retained-releases ${GITHUB_SHA}"');
    expect(pruningStep).toContain("-o StrictHostKeyChecking=yes");
    expect(pruningStep).toContain('UserKnownHostsFile="$HOME/.ssh/known_hosts"');
    expect(pruningStep).toContain('"deploy-setlivre@${PRODUCTION_VM_HOST}"');
    expect(pruningStep).toContain("--prune-functions");
    expect(pruningStep).toContain('RETAINED_RELEASE_INVENTORY="$inventory"');
    expect(pruningStep).toContain("MEDIA_CLEANUP_FUNCTION_SLUG:");
    expect(pruningStep).toContain("SUPABASE_ACCESS_TOKEN:");
    expect(pruningStep).not.toContain("continue-on-error");
    expect(pruningStep).not.toContain("if: always()");
    expect(pruningStep.indexOf('"retained-releases ${GITHUB_SHA}"')).toBeLessThan(
      pruningStep.indexOf("--prune-functions"),
    );
    expect(deployJob.slice(0, pruning)).not.toContain("--prune-functions");
  });

  it("initializes once, resumes without rotation, and validates an active credential", () => {
    expect(productionRoleActivationMode(initialRuntimeRole)).toBe("initialize");
    expect(productionRoleActivationMode({ ...restrictedRuntimeRole, canLogin: false })).toBe(
      "resume",
    );
    expect(productionRoleActivationMode(restrictedRuntimeRole)).toBe("validate");
    expect(() => productionRoleActivationMode({ ...initialRuntimeRole, canLogin: true })).toThrow(
      "LOGIN sem verificador",
    );
    expect(
      productionRoleActivationMode({
        ...initialRuntimeRole,
        hasPassword: true,
      }),
    ).toBe("resume");
    expect(() =>
      productionRoleActivationMode({ ...initialRuntimeRole, connectionLimit: 20 }),
    ).toThrow("atributos restritos");
  });

  it.each([
    { migrationHeadIsCurrent: true, ready: false },
    { migrationHeadIsCurrent: false, ready: true },
  ])(
    "requires full readiness and the exact compiled head before activation (%#)",
    async (databaseReadiness) => {
      const adminQuery = productionProvisioningAdminQuery({ databaseReadiness });
      const admin = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: adminQuery,
      };
      const createClient = vi.fn(() => admin);
      await expect(
        provisionProductionRole(
          {
            ...fixedCoordinates,
            PRD_DATABASE_URL_APP_DAL: runtimeUrl,
            SUPABASE_DB_PASSWORD: "admin-secret",
            SUPABASE_PROJECT_REF: projectRef,
          },
          { createClient },
        ),
      ).rejects.toThrow("migration head de produção ou a fronteira DAL");
      expect(adminQuery).toHaveBeenCalledWith(
        expect.stringContaining("private.check_readiness($1::text) as ready"),
        [databaseMigrationHead],
      );
      expect(adminQuery).toHaveBeenCalledWith("rollback");
      expect(adminQuery).not.toHaveBeenCalledWith("commit");
      expect(adminQuery.mock.calls.flat().join(" ")).not.toContain(
        "alter role app_runtime_production login",
      );
      expect(createClient).toHaveBeenCalledOnce();
      expect(admin.end).toHaveBeenCalledOnce();
    },
  );

  it("commits the initial password before validating the runtime", async () => {
    const adminQuery = productionProvisioningAdminQuery();
    const runtimeQuery = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ currentRole: "app_dal", ready: true, sessionRole: "app_runtime_production" }],
    }));
    const clients = [
      {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: adminQuery,
      },
      {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: runtimeQuery,
      },
    ];

    await expect(
      provisionProductionRole(
        {
          ...fixedCoordinates,
          PRD_DATABASE_URL_APP_DAL: runtimeUrl,
          SUPABASE_DB_PASSWORD: "admin-secret",
          SUPABASE_PROJECT_REF: projectRef,
        },
        { createClient: () => clients.shift() },
      ),
    ).resolves.toBeUndefined();

    const statements = adminQuery.mock.calls.map(([statement]) => String(statement));
    const password = statements.indexOf(
      "alter role app_runtime_production login password 'runtime-secret'",
    );
    const commit = statements.indexOf("commit");
    expect(password).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(password);
    expect(runtimeQuery).toHaveBeenCalledOnce();
  });

  it("resumes a compensated role without replacing its password", async () => {
    const adminQuery = productionProvisioningAdminQuery({
      roles: [restrictedAppDalRole, { ...restrictedRuntimeRole, canLogin: false }],
    });
    const runtimeQuery = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ currentRole: "app_dal", ready: true, sessionRole: "app_runtime_production" }],
    }));
    const clients = [
      {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: adminQuery,
      },
      {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: runtimeQuery,
      },
    ];
    const createClient = vi.fn(() => clients.shift());

    await expect(
      provisionProductionRole(
        {
          ...fixedCoordinates,
          PRD_DATABASE_URL_APP_DAL: runtimeUrl,
          SUPABASE_DB_PASSWORD: "admin-secret",
          SUPABASE_PROJECT_REF: projectRef,
        },
        { createClient },
      ),
    ).resolves.toBeUndefined();

    expect(adminQuery).toHaveBeenCalledWith("alter role app_runtime_production login");
    expect(adminQuery.mock.calls.flat().join(" ")).not.toContain(
      "alter role app_runtime_production login password",
    );
    expect(runtimeQuery).toHaveBeenCalledOnce();
  });

  it("closes a failed readiness client before terminating runtime sessions", async () => {
    const events = [];
    const adminQuery = productionProvisioningAdminQuery();
    const runtimeEnd = vi.fn(async () => {
      events.push("runtime:end");
    });
    const recoveryQuery = vi.fn(async (statement) => {
      if (String(statement).includes("pg_terminate_backend")) events.push("recovery:terminate");
      return { rowCount: null, rows: [] };
    });
    const verifierQuery = vi.fn(async (statement) => {
      if (String(statement).includes("authentication.rolpassword is not null")) {
        return {
          rowCount: 1,
          rows: [{ activeConnections: 0, canLogin: false, hasPassword: true }],
        };
      }
      return { rowCount: null, rows: [] };
    });
    const clients = [
      {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: adminQuery,
      },
      {
        connect: vi.fn(async () => undefined),
        end: runtimeEnd,
        query: vi.fn(async () => ({
          rowCount: 1,
          rows: [
            {
              currentRole: "app_runtime_production",
              ready: false,
              sessionRole: "app_runtime_production",
            },
          ],
        })),
      },
      {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: recoveryQuery,
      },
      {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: verifierQuery,
      },
    ];

    await expect(
      provisionProductionRole(
        {
          ...fixedCoordinates,
          PRD_DATABASE_URL_APP_DAL: runtimeUrl,
          SUPABASE_DB_PASSWORD: "admin-secret",
          SUPABASE_PROJECT_REF: projectRef,
        },
        { createClient: () => clients.shift() },
      ),
    ).rejects.toThrow("readiness restrito");

    expect(runtimeEnd).toHaveBeenCalledOnce();
    expect(events).toEqual(["runtime:end", "recovery:terminate"]);
  });

  it("preserves the verifier and waits for runtime session termination", async () => {
    let activeConnections = 2;
    let canLogin = true;
    let currentTime = 0;
    const clients = [];
    const wait = vi.fn(async (milliseconds) => {
      currentTime += milliseconds;
      activeConnections = 0;
    });
    const createClient = () => {
      const clientIndex = clients.length;
      const client = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async (statement) => {
          const sql = String(statement).trim().toLowerCase();
          if (clientIndex === 0 && sql === "commit") canLogin = false;
          if (clientIndex === 0 && sql.includes('count(*)::integer as "activeconnections"')) {
            return { rowCount: 1, rows: [{ activeConnections }] };
          }
          if (sql.includes("authentication.rolpassword is not null")) {
            return {
              rowCount: 1,
              rows: [
                {
                  activeConnections,
                  canLogin,
                  hasPassword: true,
                },
              ],
            };
          }
          return { rowCount: null, rows: [] };
        }),
      };
      clients.push(client);
      return client;
    };

    await expect(
      forceProductionRoleDisabled({
        adminConnection: { application_name: "test" },
        createClient,
        currentTime: () => currentTime,
        wait,
      }),
    ).resolves.toBeUndefined();
    expect(canLogin).toBe(false);
    expect(activeConnections).toBe(0);
    expect(clients).toHaveLength(2);
    expect(clients[0].query).toHaveBeenCalledWith("alter role app_runtime_production nologin");
    expect(clients[0].query).toHaveBeenCalledWith(
      expect.stringContaining("pg_terminate_backend(activity.pid)"),
    );
    const recoveryQueries = clients[0].query.mock.calls.map(([statement]) => String(statement));
    expect(recoveryQueries.findIndex((sql) => sql.includes("pg_terminate_backend"))).toBeLessThan(
      recoveryQueries.findIndex((sql) => sql.includes('count(*)::integer as "activeConnections"')),
    );
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(250);
    expect(clients[0].query.mock.calls.flat().join(" ")).not.toContain("password null");
  });

  it("uses one termination deadline across retries for all ten supported sessions", async () => {
    let currentTime = 0;
    const clients = [];
    const wait = vi.fn(async (milliseconds) => {
      currentTime += milliseconds;
    });
    const createClient = () => {
      const clientIndex = clients.length;
      const client = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async (statement) => {
          const sql = String(statement).trim().toLowerCase();
          if (clientIndex === 0 && sql.includes('count(*)::integer as "activeconnections"')) {
            currentTime = 3_000;
            throw new Error("transient session count failure");
          }
          if (clientIndex === 1 && sql.includes("authentication.rolpassword is not null")) {
            return {
              rowCount: 1,
              rows: [{ activeConnections: 10, canLogin: false, hasPassword: true }],
            };
          }
          if (sql.includes('count(*)::integer as "activeconnections"')) {
            return { rowCount: 1, rows: [{ activeConnections: 10 }] };
          }
          return { rowCount: null, rows: [] };
        }),
      };
      clients.push(client);
      return client;
    };

    await expect(
      forceProductionRoleDisabled({
        adminConnection: { application_name: "test" },
        createClient,
        currentTime: () => currentTime,
        maximumAttempts: 3,
        wait,
      }),
    ).rejects.toThrow("comprovar a desativação");

    expect(clients).toHaveLength(3);
    expect(wait).toHaveBeenCalledTimes(8);
    expect(wait.mock.calls.reduce((total, [milliseconds]) => total + milliseconds, 0)).toBe(2_000);
    expect(
      clients.flatMap((client) =>
        client.query.mock.calls.filter(([statement]) =>
          String(statement).includes("pg_terminate_backend"),
        ),
      ),
    ).toHaveLength(2);
  });

  it("accepts the verifier-free initial state after an ambiguous initialization commit", async () => {
    let canLogin = true;
    const clients = [];
    const createClient = () => {
      const clientIndex = clients.length;
      const client = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async (statement) => {
          const sql = String(statement).trim().toLowerCase();
          if (clientIndex === 0 && sql === "commit") {
            canLogin = false;
            throw new Error("connection lost after commit");
          }
          if (sql.includes("authentication.rolpassword is not null")) {
            return {
              rowCount: 1,
              rows: [
                {
                  activeConnections: 0,
                  canLogin,
                  hasPassword: false,
                },
              ],
            };
          }
          return { rowCount: null, rows: [] };
        }),
      };
      clients.push(client);
      return client;
    };

    await expect(
      forceProductionRoleDisabled({
        adminConnection: { application_name: "test" },
        allowMissingVerifier: true,
        createClient,
      }),
    ).resolves.toBeUndefined();
    expect(canLogin).toBe(false);
    expect(clients).toHaveLength(2);
    expect(clients[0].query).toHaveBeenCalledWith("commit");
    expect(clients[0].query).not.toHaveBeenCalledWith("rollback");
    expect(clients[1].query).toHaveBeenCalledOnce();
  });

  it("rejects a verifier-free state when compensating a resume", async () => {
    let clientIndex = 0;
    const createClient = () => {
      const currentIndex = clientIndex;
      clientIndex += 1;
      return {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async (statement) => {
          const sql = String(statement).trim().toLowerCase();
          if (currentIndex === 1 && sql.includes("authentication.rolpassword is not null")) {
            return {
              rowCount: 1,
              rows: [
                {
                  activeConnections: 0,
                  canLogin: false,
                  hasPassword: false,
                },
              ],
            };
          }
          return { rowCount: null, rows: [] };
        }),
      };
    };

    await expect(
      forceProductionRoleDisabled({
        adminConnection: { application_name: "test" },
        createClient,
        maximumAttempts: 1,
      }),
    ).rejects.toThrow("comprovar a desativação");
  });

  it("fails closed when a fresh connection still observes LOGIN", async () => {
    let clientIndex = 0;
    const createClient = () => {
      const currentIndex = clientIndex;
      clientIndex += 1;
      return {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async (statement) => {
          const sql = String(statement).trim().toLowerCase();
          if (currentIndex === 1 && sql.includes("authentication.rolpassword is not null")) {
            return {
              rowCount: 1,
              rows: [
                {
                  activeConnections: 0,
                  canLogin: true,
                  hasPassword: true,
                },
              ],
            };
          }
          return { rowCount: null, rows: [] };
        }),
      };
    };

    await expect(
      forceProductionRoleDisabled({
        adminConnection: { application_name: "test" },
        createClient,
        maximumAttempts: 1,
      }),
    ).rejects.toThrow("comprovar a desativação");
  });

  it("validates managed boundaries and the exact deployment head before enabling login", () => {
    const source = readFileSync(
      new URL("../../scripts/provision-production-role.mjs", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL(
        "../../supabase/migrations/20260824000100_initial_production_baseline.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const roleAssumptionMigration = readFileSync(
      new URL(
        "../../supabase/migrations/20260828174500_default_production_dal_role.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const cloudDeliveryDecision = readFileSync(
      new URL("../../docs/adr/ADR-019-controlled-cloud-delivery.md", import.meta.url),
      "utf8",
    );
    const boundaryCheck = source.indexOf(
      "select private.managed_runtime_boundaries_are_ready() as ready",
    );
    const reverseMembershipCheck = source.indexOf(
      "where granted.rolname = 'app_runtime_production'",
    );
    const databaseReadiness = source.indexOf("private.check_readiness($1::text) as ready");
    const exactMigrationHead = source.indexOf("pg_catalog.max(migration.version)::text = $1::text");
    const passwordActivation = source.indexOf("alter role app_runtime_production login password");
    const passwordPreservingResume = source.indexOf(
      'admin.query("alter role app_runtime_production login")',
      passwordActivation,
    );
    const ambiguousActivationFence = source.indexOf("activationMayHaveCommitted = true");
    const activationCommit = source.indexOf('await admin.query("commit")', passwordActivation);
    const compensation = source.indexOf("await forceProductionRoleDisabled({", activationCommit);

    expect(reverseMembershipCheck).toBeGreaterThan(-1);
    expect(boundaryCheck).toBeGreaterThan(reverseMembershipCheck);
    expect(databaseReadiness).toBeGreaterThan(boundaryCheck);
    expect(exactMigrationHead).toBeGreaterThan(databaseReadiness);
    expect(passwordActivation).toBeGreaterThan(exactMigrationHead);
    expect(passwordPreservingResume).toBeGreaterThan(passwordActivation);
    expect(ambiguousActivationFence).toBeGreaterThan(passwordActivation);
    expect(activationCommit).toBeGreaterThan(ambiguousActivationFence);
    expect(compensation).toBeGreaterThan(activationCommit);
    expect(source).toContain("alter role app_runtime_production nologin");
    expect(source).not.toContain("alter role app_runtime_production nologin password null");
    expect(source).toContain("pg_catalog.pg_terminate_backend(activity.pid)");
    expect(source).not.toContain("pg_catalog.pg_terminate_backend(activity.pid, 5000)");
    expect(source).toContain("runtimeTerminationTimeoutMilliseconds = 5_000");
    expect(source).toContain("from pg_catalog.pg_roles as role");
    expect(source).toContain("authentication.rolpassword is not null");
    expect(source).not.toContain("select authentication.rolpassword\n");
    expect(source).toContain(
      'activationMode === "initialize" && activationCommitCompleted === false',
    );
    expect(source).not.toContain("app.settings.jwt_secret");
    expect(migration).toContain("ADR-019 treats these as compensating safeguards");
    expect(migration).toContain(
      "(select ready from sensitive_catalog_access_is_restricted)\n      or (select ready from sensitive_settings_are_absent)",
    );
    expect(roleAssumptionMigration).toContain(
      'ALTER ROLE "app_runtime_production" IN DATABASE "postgres" SET "role" TO \'app_dal\';',
    );
    expect(roleAssumptionMigration).toContain("setting.setconfig = array['role=app_dal']::text[]");
    expect(cloudDeliveryDecision).toContain(
      "A produção não armazena segredo em GUC de role/database",
    );
  });
});
