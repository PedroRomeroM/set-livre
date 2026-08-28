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
const restrictedRuntimeRole = Object.freeze({
  bypassRls: false,
  canLogin: true,
  connectionLimit: 10,
  createDatabase: false,
  createRole: false,
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
  roleName: "app_dal",
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
    currentMigrationHead: "20260824000100",
    managedBoundariesReady: true,
    ready: true,
  },
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
            currentMigrationHead: migrationCount === 0 ? null : "20260824000100",
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
    if (sql.includes("with current_head as")) {
      return { rowCount: 1, rows: [currentBoundary] };
    }
    throw new Error("consulta administrativa inesperada no preflight de teste");
  });
}

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

  it("validates the deployed DAL boundary while the runtime role is still NOLOGIN", async () => {
    const connections = productionRoleConnections({
      PRD_DATABASE_URL_APP_DAL: runtimeUrl,
      SUPABASE_DB_PASSWORD: "admin-secret",
      SUPABASE_PROJECT_REF: projectRef,
    });
    const query = productionPreflightAdminQuery({
      roles: [restrictedAppDalRole, { ...restrictedRuntimeRole, canLogin: false }],
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
    expect(query).toHaveBeenCalledWith(expect.stringContaining("with current_head as"));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("private.check_readiness(current_head.version)"),
    );
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
        query:
          clientIndex === 0
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
      verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient }),
    ).rejects.toThrow("credencial runtime ativa não autenticou antes das migrations");
    expect(clients).toHaveLength(2);
    expect(clients[0].end).toHaveBeenCalledOnce();
    expect(clients[1].end).toHaveBeenCalledOnce();
  });

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
            currentMigrationHead: "20260824000100",
            managedBoundariesReady: false,
            ready: true,
          },
        },
        cause: "fronteira DAL implantada",
      },
      {
        options: {
          currentBoundary: {
            currentMigrationHead: "20260824000100",
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
      "- name: Inspect exact immutable release on Oracle VM",
      "- name: Build web release",
      "- name: Build backoffice release",
      "- name: Package immutable release",
      "- name: Prepare ephemeral runtime environments",
      "- name: Stage and verify release on Oracle VM",
      "- name: Select exact verified release",
      "- name: Apply forward-only Supabase migrations",
      "- name: Activate and verify the restricted production role",
      "- name: Activate staged release on Oracle VM",
      "- name: Verify public web health",
    ];
    const positions = orderedSteps.map((step) => deployJob.indexOf(step));
    const preflight = positions[0];
    const sshAuthentication = positions[1];
    const publicHttps = positions[2];
    const releaseInspection = positions[3];
    const webBuild = positions[4];
    const staging = positions[8];
    const releaseSelection = positions[9];
    const migrations = positions[10];
    const activation = positions[12];
    const publicHealth = positions[13];

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(deployJob.slice(preflight, sshAuthentication)).toContain(
      "NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/ops/certificates/supabase-root-2021-ca.crt",
    );
    const sshProbe = deployJob.slice(sshAuthentication, publicHttps);
    expect(sshProbe).toContain('[[ "$known_host" == "$PRODUCTION_VM_HOST" ]]');
    expect(sshProbe).toContain('UserKnownHostsFile="$HOME/.ssh/known_hosts"');
    expect(sshProbe).toContain('"deploy-setlivre@${PRODUCTION_VM_HOST}" preflight');
    expect(sshProbe).toContain('[[ "$deployment_probe" == "set-livre-deploy-ready-v7" ]]');
    const httpsProbe = deployJob.slice(publicHttps, releaseInspection);
    expect(httpsProbe).toContain("--proto '=https'");
    expect(httpsProbe).toContain("--tlsv1.2");
    expect(httpsProbe).toContain('"$status" == 200');
    expect(httpsProbe).toContain("User-agent: *\\nDisallow: /");
    expect(httpsProbe).toContain("X-Robots-Tag: noindex, nofollow, noarchive, nosnippet");
    const inspectionStep = deployJob.slice(releaseInspection, webBuild);
    expect(inspectionStep).toContain('"inspect ${GITHUB_SHA}"');
    expect(inspectionStep).toContain('echo "reuse=true" >> "$GITHUB_OUTPUT"');
    expect(inspectionStep).toContain('echo "reuse=false" >> "$GITHUB_OUTPUT"');
    const buildAndStage = deployJob.slice(webBuild, releaseSelection);
    expect(
      buildAndStage.match(/if: steps\.existing_release\.outputs\.reuse != 'true'/gu),
    ).toHaveLength(5);
    expect(deployJob.indexOf("npm run build:web")).toBeLessThan(migrations);
    expect(deployJob.indexOf("npm run build:backoffice")).toBeLessThan(migrations);
    expect(deployJob.indexOf("npm run release")).toBeLessThan(migrations);
    expect(deployJob.indexOf("cmp --silent")).toBeLessThan(migrations);
    expect(deployJob.indexOf("write_environment")).toBeLessThan(migrations);
    const stagingStep = deployJob.slice(staging, migrations);
    expect(stagingStep).toContain('"upload-release ${GITHUB_SHA}"');
    expect(stagingStep).toContain('"upload-web-environment ${GITHUB_SHA}"');
    expect(stagingStep).toContain('"upload-backoffice-environment ${GITHUB_SHA}"');
    expect(stagingStep).toContain('"stage ${GITHUB_SHA} ${CHECKSUM}"');
    const selectionStep = deployJob.slice(releaseSelection, migrations);
    expect(selectionStep).toContain('checksum="$EXISTING_CHECKSUM"');
    expect(selectionStep).toContain('checksum="$BUILT_CHECKSUM"');
    const activationStep = deployJob.slice(activation, publicHealth);
    expect(activationStep).toContain('"activate ${GITHUB_SHA} ${CHECKSUM}"');
    expect(activationStep).toContain("CHECKSUM: ${{ steps.selected_release.outputs.checksum }}");
    expect(activationStep).not.toContain("upload-release");
  });

  it("initializes credentials only for the migration-created NOLOGIN role", () => {
    const restrictedRole = {
      ...restrictedRuntimeRole,
      canLogin: false,
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
