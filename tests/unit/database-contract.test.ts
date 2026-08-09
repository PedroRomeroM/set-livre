import { describe, expect, it } from "vitest";

import { parseDalDatabaseUrl } from "../../packages/contracts/src";

const validUrl =
  "postgresql://app_runtime:secret@db.example.test:6543/set_livre?sslmode=verify-full&options=-c%20role%3Dapp_dal";

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
});
