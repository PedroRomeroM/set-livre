import { describe, expect, it } from "vitest";

import { isDatabaseReadinessSatisfied } from "../../packages/contracts/src/database-readiness-contract";
import { parseDalDatabaseUrl } from "../../packages/contracts/src";

const validUrl =
  "postgresql://app_runtime:secret@db.example.test:6543/set_livre?sslmode=verify-full&options=-c%20role%3Dapp_dal";
const restrictedReadinessRow = {
  currentRole: "app_dal",
  ready: true,
  runtimeReady: true,
  sessionRole: "app_runtime",
};
const restrictedReadinessRows = [restrictedReadinessRow];

describe("DAL database URL contract", () => {
  it("accepts a restricted session role with required SET ROLE and TLS parameters", () => {
    expect(parseDalDatabaseUrl(validUrl)).toEqual({
      connectionString: validUrl,
      sessionRole: "app_runtime",
    });
  });

  it("rejects non-PostgreSQL protocols and incomplete authority", () => {
    for (const value of [
      "https://app_runtime:secret@db.example.test/set_livre?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime@db.example.test/set_livre?options=-c%20role%3Dapp_dal",
      "postgresql://app_runtime:secret@db.example.test/?options=-c%20role%3Dapp_dal",
    ]) {
      expect(() => parseDalDatabaseUrl(value)).toThrow();
    }
  });

  it("rejects known privileged login identities", () => {
    for (const role of ["postgres", "service_role", "supabase_admin"]) {
      expect(() =>
        parseDalDatabaseUrl(
          `postgresql://${role}:secret@db.example.test/set_livre?options=-c%20role%3Dapp_dal`,
        ),
      ).toThrow("role privilegiada");
    }
  });

  it("requires exactly one startup option that assumes app_dal", () => {
    for (const query of [
      "",
      "?options=-c%20role%3Dpostgres",
      "?options=-c%20role%3Dapp_dal&options=-c%20role%3Dpostgres",
    ]) {
      expect(() =>
        parseDalDatabaseUrl(`postgresql://app_runtime:secret@db.example.test/set_livre${query}`),
      ).toThrow("assumir app_dal");
    }
  });

  it("rejects query parameters that can override connection identity", () => {
    for (const parameter of ["host=remote.example.test", "role=postgres", "user=postgres"]) {
      expect(() => parseDalDatabaseUrl(`${validUrl}&${parameter}`)).toThrow(
        "sobrescrever sua identidade",
      );
    }
  });

  it("accepts readiness only when the login and effective DAL role are restricted", () => {
    expect(isDatabaseReadinessSatisfied(restrictedReadinessRows, "app_runtime")).toBe(true);
    expect(
      isDatabaseReadinessSatisfied(
        [{ ...restrictedReadinessRow, runtimeReady: false }],
        "app_runtime",
      ),
    ).toBe(false);
    expect(
      isDatabaseReadinessSatisfied([{ ...restrictedReadinessRow, ready: false }], "app_runtime"),
    ).toBe(false);
  });

  it("rejects a different effective role even when every boolean claim is true", () => {
    expect(() =>
      isDatabaseReadinessSatisfied(
        [{ ...restrictedReadinessRow, currentRole: "postgres" }],
        "app_runtime",
      ),
    ).toThrow();
  });
});
