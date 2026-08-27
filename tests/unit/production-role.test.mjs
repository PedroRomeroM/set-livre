import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assertProductionDeploymentContract,
  assertSupabasePublishableKey,
  forceProductionRoleDisabled,
  productionRoleActivationMode,
  productionRoleConnections,
} from "../../scripts/provision-production-role.mjs";

const projectRef = "oirvvnojgkzdppkdvhej";
const runtimeUrl =
  "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:runtime%23secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal";

describe("production role provisioning", () => {
  const fixedCoordinates = {
    PRODUCTION_BACKOFFICE_APP_URL: "https://ops.setlivre.com",
    PRODUCTION_PUBLIC_APP_URL: "https://147.15.97.227",
    PRODUCTION_SUPABASE_URL: "https://oirvvnojgkzdppkdvhej.supabase.co",
    PRODUCTION_VM_HOST: "147.15.97.227",
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
    ).toThrow("role e o projeto");
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

  it("initializes credentials only for the migration-created NOLOGIN role", () => {
    const restrictedRole = {
      bypassRls: false,
      canLogin: false,
      connectionLimit: 10,
      createDatabase: false,
      createRole: false,
      inherit: false,
      replication: false,
      superuser: false,
    };

    expect(productionRoleActivationMode(restrictedRole)).toBe("initialize");
    expect(productionRoleActivationMode({ ...restrictedRole, canLogin: true })).toBe("validate");
    expect(() => productionRoleActivationMode({ ...restrictedRole, connectionLimit: 20 })).toThrow(
      "atributos restritos",
    );
  });

  it("proves NOLOGIN with a fresh connection after an ambiguous compensation commit", async () => {
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
          if (sql.includes('role.rolcanlogin as "canlogin"')) {
            return { rowCount: 1, rows: [{ canLogin }] };
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
      }),
    ).resolves.toBeUndefined();
    expect(canLogin).toBe(false);
    expect(clients).toHaveLength(2);
    expect(clients[0].query).toHaveBeenCalledWith("commit");
    expect(clients[1].query).toHaveBeenCalledOnce();
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
          if (currentIndex === 1 && sql.includes('role.rolcanlogin as "canlogin"')) {
            return { rowCount: 1, rows: [{ canLogin: true }] };
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
    const boundaryCheck = source.indexOf(
      "select private.managed_runtime_boundaries_are_ready() as ready",
    );
    const reverseMembershipCheck = source.indexOf(
      "where granted.rolname = 'app_runtime_production'",
    );
    const databaseReadiness = source.indexOf("private.check_readiness($1::text) as ready");
    const exactMigrationHead = source.indexOf("pg_catalog.max(migration.version)::text = $1::text");
    const passwordActivation = source.indexOf("alter role app_runtime_production login password");
    const ambiguousActivationFence = source.indexOf("activationMayHaveCommitted = true");
    const activationCommit = source.indexOf('await admin.query("commit")', passwordActivation);
    const compensation = source.indexOf("await forceProductionRoleDisabled({", activationCommit);

    expect(reverseMembershipCheck).toBeGreaterThan(-1);
    expect(boundaryCheck).toBeGreaterThan(reverseMembershipCheck);
    expect(databaseReadiness).toBeGreaterThan(boundaryCheck);
    expect(exactMigrationHead).toBeGreaterThan(databaseReadiness);
    expect(passwordActivation).toBeGreaterThan(exactMigrationHead);
    expect(ambiguousActivationFence).toBeGreaterThan(passwordActivation);
    expect(activationCommit).toBeGreaterThan(ambiguousActivationFence);
    expect(compensation).toBeGreaterThan(activationCommit);
    expect(source).not.toContain("app.settings.jwt_secret");
  });
});
