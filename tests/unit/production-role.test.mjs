import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assertProductionDeploymentContract,
  assertSupabasePublishableKey,
  forceProductionRoleDisabled,
  productionRoleActivationMode,
  productionRoleConnections,
  verifyProductionDeploymentContract,
  verifyProductionRuntimeCredentialBeforeMigrations,
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

    expect(() =>
      productionRoleConnections({
        PRD_DATABASE_URL_APP_DAL: runtimeUrl.replace(
          "aws-0-sa-east-1.pooler.supabase.com",
          "aws-0-us-east-1.pooler.supabase.com",
        ),
        SUPABASE_DB_PASSWORD: "admin-secret",
        SUPABASE_PROJECT_REF: projectRef,
      }),
    ).toThrow("pooler session exato");
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
        query: vi.fn(async () =>
          admin
            ? { rowCount: 1, rows: [{ canLogin: true }] }
            : { rowCount: 1, rows: [{ authenticated: true }] },
        ),
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
    expect(clients[1].query).toHaveBeenCalledWith("select true as authenticated");
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

  it("allows first initialization states without attempting a runtime login", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });

    for (const role of [
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ canLogin: false }] },
    ]) {
      const createClient = vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async () => role),
      }));
      await expect(
        verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
      ).resolves.toBeUndefined();
      expect(createClient).toHaveBeenCalledOnce();
    }
  });

  it("rejects a stale credential for an already active runtime before migrations", async () => {
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
        query: vi.fn(async () => ({ rowCount: 1, rows: [{ canLogin: true }] })),
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

  it("runs the key probe before migrations, builds, and packaging", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const preflight = workflow.indexOf("- name: Validate fixed production contract");
    const migrations = workflow.indexOf("- name: Apply forward-only Supabase migrations");
    const webBuild = workflow.indexOf("- name: Build web release");
    const packaging = workflow.indexOf("- name: Package immutable release");

    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(migrations);
    expect(workflow.slice(preflight, migrations)).toContain(
      "NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/ops/certificates/supabase-root-2021-ca.crt",
    );
    expect(migrations).toBeLessThan(webBuild);
    expect(webBuild).toBeLessThan(packaging);
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
    const migration = readFileSync(
      new URL(
        "../../supabase/migrations/20260824000100_initial_production_baseline.sql",
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
    expect(migration).toContain("ADR-019 treats these as compensating safeguards");
    expect(migration).toContain(
      "(select ready from sensitive_catalog_access_is_restricted)\n      or (select ready from sensitive_settings_are_absent)",
    );
    expect(cloudDeliveryDecision).toContain(
      "A produção não armazena segredo em GUC de role/database",
    );
  });
});
