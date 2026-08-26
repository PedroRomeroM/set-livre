import { describe, expect, it } from "vitest";

import {
  assertProductionDeploymentContract,
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
});
