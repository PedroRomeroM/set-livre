import { describe, expect, it } from "vitest";

import { assertSafeE2EEnvironment } from "../helpers/e2e-safety";

const safeInput = {
  adminDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  backofficeBaseUrl: "http://127.0.0.1:3001",
  databaseMarker: "local-only-marker-0000000000000000",
  dalDatabaseUrl:
    "postgresql://app_runtime_local:local-secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
  explicitLocalPermission: "1" as const,
  publicBaseUrl: "http://127.0.0.1:3000",
  supabaseUrl: "http://127.0.0.1:54321",
};

describe("E2E safety guard", () => {
  it("accepts an explicitly local environment", () => {
    expect(() => assertSafeE2EEnvironment(safeInput)).not.toThrow();
  });

  it.each([
    ["publicBaseUrl", "https://setlivre.example"],
    ["backofficeBaseUrl", "https://admin.setlivre.example"],
    ["supabaseUrl", "https://project.supabase.co"],
    ["adminDatabaseUrl", "postgresql://user:pass@db.example/setlivre"],
    ["dalDatabaseUrl", "postgresql://user:pass@db.example/setlivre"],
  ] as const)("rejects a remote %s", (key, value) => {
    expect(() => assertSafeE2EEnvironment({ ...safeInput, [key]: value })).toThrow(
      "precisa apontar para localhost",
    );
  });

  it.each([
    ["publicBaseUrl", "http://127.0.0.1:3999"],
    ["backofficeBaseUrl", "http://127.0.0.1:3998"],
    ["supabaseUrl", "http://127.0.0.1:54320"],
    ["adminDatabaseUrl", "postgresql://postgres:postgres@127.0.0.1:54321/postgres"],
    [
      "dalDatabaseUrl",
      "postgresql://app_runtime_local:local-secret@127.0.0.1:54321/postgres?options=-c%20role%3Dapp_dal",
    ],
  ] as const)("rejects an unexpected local port for %s", (key, value) => {
    expect(() => assertSafeE2EEnvironment({ ...safeInput, [key]: value })).toThrow(
      "precisa usar a porta local",
    );
  });

  it("rejects HTTPS because the local web servers are HTTP-only", () => {
    expect(() =>
      assertSafeE2EEnvironment({ ...safeInput, publicBaseUrl: "https://127.0.0.1:3000" }),
    ).toThrow("protocolo não permitido");
  });

  it.each([
    ["publicBaseUrl", "http://127.0.0.1:3000/path"],
    ["backofficeBaseUrl", "http://127.0.0.1:3001/?mode=test"],
    ["supabaseUrl", "http://user:pass@127.0.0.1:54321"],
  ] as const)("rejects a non-origin-only %s", (key, value) => {
    expect(() => assertSafeE2EEnvironment({ ...safeInput, [key]: value })).toThrow(
      "precisa ser uma origem local",
    );
  });

  it("requires an explicit local permission marker", () => {
    expect(() =>
      assertSafeE2EEnvironment({ ...safeInput, explicitLocalPermission: "0" }),
    ).toThrow();
  });

  it("requires an explicit local database URL", () => {
    expect(() => assertSafeE2EEnvironment({ ...safeInput, adminDatabaseUrl: undefined })).toThrow();
  });

  it("requires the expected local admin database identity", () => {
    expect(() =>
      assertSafeE2EEnvironment({
        ...safeInput,
        adminDatabaseUrl: "postgresql://other:secret@127.0.0.1:54322/postgres",
      }),
    ).toThrow("identidade administrativa local esperada");
  });

  it("requires an ephemeral local database marker", () => {
    expect(() =>
      assertSafeE2EEnvironment({ ...safeInput, databaseMarker: "not-a-valid-marker" }),
    ).toThrow();
  });

  it("rejects a DAL connection that uses the postgres identity", () => {
    expect(() =>
      assertSafeE2EEnvironment({
        ...safeInput,
        dalDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      }),
    ).toThrow("identidade DAL local restrita");
  });
});
