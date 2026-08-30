import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { assertSafeE2EEnvironment } from "../helpers/e2e-safety";

function jwtForRole(role: string) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "supabase", role })).toString("base64url");
  return `${header}.${payload}.contract-signature`;
}

const safeInput = {
  adminDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  backofficeBaseUrl: "http://127.0.0.1:3001",
  backofficeRuntimeUnlockKey: "A".repeat(43),
  databaseMarker: "local-only-marker-0000000000000000",
  dalDatabaseUrl:
    "postgresql://app_runtime_local:local-secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
  explicitLocalPermission: "1" as const,
  publicBaseUrl: "http://127.0.0.1:3000",
  supabaseAnonKey: jwtForRole("anon"),
  supabaseUrl: "http://127.0.0.1:54321",
};
const nonLiteralLocalHosts = [
  "localhost",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "127.1",
  "0177.0.0.1",
  "0x7f000001",
  "2130706433",
  "127.000.000.001",
  "127.0.0.1.",
  "127%2e0%2e0%2e1",
  "127。0。0。1",
] as const;

describe("E2E safety guard", () => {
  it("accepts an explicitly local environment", () => {
    expect(() => assertSafeE2EEnvironment(safeInput)).not.toThrow();
    expect(() =>
      assertSafeE2EEnvironment({
        ...safeInput,
        supabaseAnonKey: "sb_publishable_local_contract_key",
      }),
    ).not.toThrow();
  });

  it("rejects a Supabase service role key at the public application boundary", () => {
    expect(() =>
      assertSafeE2EEnvironment({ ...safeInput, supabaseAnonKey: jwtForRole("service_role") }),
    ).toThrow("role pública anon");
  });

  it.each([
    ["publicBaseUrl", "https://setlivre.example"],
    ["backofficeBaseUrl", "https://admin.setlivre.example"],
    ["supabaseUrl", "https://project.supabase.co"],
    ["adminDatabaseUrl", "postgresql://user:pass@db.example/setlivre"],
    ["dalDatabaseUrl", "postgresql://user:pass@db.example/setlivre"],
  ] as const)("rejects a remote %s", (key, value) => {
    expect(() => assertSafeE2EEnvironment({ ...safeInput, [key]: value })).toThrow(
      "host IPv4 literal 127.0.0.1",
    );
  });

  it.each(nonLiteralLocalHosts)(
    "rejects the non-literal local host representation %s in every E2E URL",
    (host) => {
      const values = {
        adminDatabaseUrl: `postgresql://postgres:postgres@${host}:54322/postgres`,
        backofficeBaseUrl: `http://${host}:3001`,
        dalDatabaseUrl: `postgresql://app_runtime_local:local-secret@${host}:54322/postgres?options=-c%20role%3Dapp_dal`,
        publicBaseUrl: `http://${host}:3000`,
        supabaseUrl: `http://${host}:54321`,
      } as const;

      for (const [key, value] of Object.entries(values)) {
        expect(() => assertSafeE2EEnvironment({ ...safeInput, [key]: value })).toThrow(
          "host IPv4 literal 127.0.0.1",
        );
      }
    },
  );

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
