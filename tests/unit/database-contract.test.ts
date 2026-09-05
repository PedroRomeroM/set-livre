import { describe, expect, it } from "vitest";

import { isDatabaseReadinessSatisfied } from "../../packages/contracts/src/database-readiness-contract";
import { parseDalDatabaseUrl } from "../../packages/contracts/src";

const validUrl =
  "postgresql://app_runtime_local:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const restrictedReadinessRow = {
  currentRole: "app_dal",
  ready: true,
  runtimeReady: true,
  sessionRole: "app_runtime_local",
};
const restrictedReadinessRows = [restrictedReadinessRow];

describe("DAL database URL contract", () => {
  it("accepts a restricted session role with required SET ROLE and TLS parameters", () => {
    expect(parseDalDatabaseUrl(validUrl)).toEqual({
      connectionString: validUrl,
      projectRef: undefined,
      sessionRole: "app_runtime_local",
    });
  });

  it("supports the official Supavisor session username without confusing tenant and role", () => {
    const poolerUrl =
      "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal";
    expect(parseDalDatabaseUrl(poolerUrl)).toEqual({
      connectionString: poolerUrl,
      projectRef: "oirvvnojgkzdppkdvhej",
      sessionRole: "app_runtime_production",
    });
  });

  it("rejects non-PostgreSQL protocols and incomplete authority", () => {
    for (const value of [
      "https://app_runtime:secret@db.example.test/set_livre?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local:secret@127.0.0.1:54322/?options=-c%20role%3Dapp_dal",
    ]) {
      expect(() => parseDalDatabaseUrl(value)).toThrow();
    }
  });

  it("rejects raw control characters before URL normalization", () => {
    for (const controlCharacter of ["\n", "\r", "\t", "\u0000", "\u007f"]) {
      expect(() => parseDalDatabaseUrl(`${validUrl}${controlCharacter}`)).toThrow(
        "caractere de controle não autorizado",
      );
    }
  });

  it("requires percent-encoding for characters that are unsafe in an EnvironmentFile", () => {
    for (const unsafeCharacter of ["'", '"', "\\", " "]) {
      const unsafeUrl = validUrl.replace(":secret@", `:sec${unsafeCharacter}ret@`);
      expect(() => parseDalDatabaseUrl(unsafeUrl)).toThrow("exige percent-encoding");
    }

    const encodedQuoteUrl = validUrl.replace(":secret@", ":sec%27ret@");
    expect(parseDalDatabaseUrl(encodedQuoteUrl).connectionString).toBe(encodedQuoteUrl);
  });

  it("rejects every login identity outside the positive runtime allowlist", () => {
    for (const role of [
      "postgres",
      "service_role",
      "supabase_admin",
      "supabase_auth_admin",
      "supabase_storage_admin",
      "supabase_etl_admin",
      "storage_admin",
      "etl_admin",
      "app_runtime",
    ]) {
      expect(() =>
        parseDalDatabaseUrl(
          `postgresql://${role}:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal`,
        ),
      ).toThrow("identidade e as coordenadas canônicas");
    }
  });

  it("requires the exact local and production database coordinates", () => {
    for (const value of [
      "postgresql://app_runtime_local:secret@127.0.0.1:5432/postgres?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_local:secret@127.0.0.1:54322/other?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_production.wrongprojectref00000:secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:secret@aws-0-sa-east-1.pooler.supabase.com:5432/other?sslmode=verify-full&options=-c%20role%3Dapp_dal",
    ]) {
      expect(() => parseDalDatabaseUrl(value)).toThrow("coordenadas canônicas");
    }
  });

  it("requires exactly one startup option that assumes app_dal", () => {
    for (const query of [
      "",
      "?options=-c%20role%3Dpostgres",
      "?options=-c%20role%3Dapp_dal&options=-c%20role%3Dpostgres",
    ]) {
      expect(() =>
        parseDalDatabaseUrl(
          `postgresql://app_runtime_local:secret@127.0.0.1:54322/postgres${query}`,
        ),
      ).toThrow("assumir app_dal");
    }
  });

  it("requires verified TLS remotely and session mode for Supavisor", () => {
    expect(() =>
      parseDalDatabaseUrl(
        "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?options=-c%20role%3Dapp_dal",
      ),
    ).toThrow("TLS verify-full");
    expect(() =>
      parseDalDatabaseUrl(
        "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:secret@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal",
      ),
    ).toThrow("coordenadas canônicas");
    expect(() =>
      parseDalDatabaseUrl(
        "postgresql://postgres.oirvvnojgkzdppkdvhej:secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal",
      ),
    ).toThrow("coordenadas canônicas");
  });

  it("rejects unknown and duplicate connection parameters", () => {
    for (const parameter of [
      "host=remote.example.test",
      "role=postgres",
      "user=postgres",
      "application_name=untracked",
      "sslmode=disable",
    ]) {
      expect(() => parseDalDatabaseUrl(`${validUrl}&${parameter}`)).toThrow(
        parameter === "sslmode=disable" ? "não aceita sslmode" : "parâmetro não autorizado",
      );
    }
  });

  it("accepts readiness only when the login and effective DAL role are restricted", () => {
    expect(isDatabaseReadinessSatisfied(restrictedReadinessRows, "app_runtime_local")).toBe(true);
    expect(
      isDatabaseReadinessSatisfied(
        [{ ...restrictedReadinessRow, runtimeReady: false }],
        "app_runtime_local",
      ),
    ).toBe(false);
    expect(
      isDatabaseReadinessSatisfied(
        [{ ...restrictedReadinessRow, ready: false }],
        "app_runtime_local",
      ),
    ).toBe(false);
  });

  it("rejects a different effective role even when every boolean claim is true", () => {
    expect(() =>
      isDatabaseReadinessSatisfied(
        [{ ...restrictedReadinessRow, currentRole: "postgres" }],
        "app_runtime_local",
      ),
    ).toThrow();
  });
});
