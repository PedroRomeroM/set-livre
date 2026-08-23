import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadDalPostgresConnectionConfig } from "../../packages/contracts/src/server/postgres-connection-config";

const testCaCertificate = `-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUf9FmSqHME9v1VhkmtQz+2zxM/jowDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWU2V0IExpdnJlIFVuaXQgVGVzdCBDQTAeFw0yNjA4MTky
MjA5NDlaFw0zNjA4MTYyMjA5NDlaMCExHzAdBgNVBAMMFlNldCBMaXZyZSBVbml0
IFRlc3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDUjscZQtly
z6glgtDOToN69RBfoAd2np/HM1+erT/64L+vRivfyFaUcYHj4JTtEwOn8tyOxjGu
iAvbi5U7A2hck4b7GEYyWaXFoLbI4PPGr0EUmh+DZjK/mcEvMJ9j15keT1JrgLB8
AEmfK0zY3UbatUHKLhNaNfXvMGFVzrK3sjkqd79PziV7b0LC4ZBuQmv2+02NqINb
1S5vXWb62NGJXNeBlouqgWvNBjmKp3Yj+ZMd7Hu+gV1Ai5rfRf7OiKlIaY1WDgWY
1GZD0IgVSnfxmRxeMv8MPeP3BrvFU+w6tEtkg7d/1jSujuXWR/EDopmnJd6ld7Ii
E+z+hWZfcUZtAgMBAAGjYzBhMB0GA1UdDgQWBBTSfLPRKdwgsvzWXwAqasq3zuVS
tTAfBgNVHSMEGDAWgBTSfLPRKdwgsvzWXwAqasq3zuVStTAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEALGgljH2kFmVT
QqmuUF7xefwprbuOHqjPhsMfGMGQY9xZOWXoWSJsSesfouOzWLW3K64lISkFQeOK
n+YfphJZ1d4h8sjIAKf8z/BNmcE14E5mB38qbkmITEog84BV29Dkx9uBxKNL9hsN
ouIaQFQ2omGvZTomd6Ht6xagmJiXR+1Vqz0kKgzj6/ANBbW9NtLKyaYxP08Ndazi
MsHctZ+Arjzub0Ji0NwtsZnEMd41F6AoP0rLB+t387hCzAHzsfPpVE+PZWY7o3AO
+0Kpp6KCN+xGwPH10RoaE13wQfTY+5EOsxVGIB57VZjMEvjSq0b4KHoZkhmXNUd3
Ba2sPXArcQ==
-----END CERTIFICATE-----
`;

const testLeafCertificate = `-----BEGIN CERTIFICATE-----
MIIDNDCCAhygAwIBAgIUEvvt3mivrWGQH8xCEVFt5HkLMyIwDQYJKoZIhvcNAQEL
BQAwIzEhMB8GA1UEAwwYU2V0IExpdnJlIFVuaXQgVGVzdCBMZWFmMB4XDTI2MDgx
OTIyMDk0OVoXDTM2MDgxNjIyMDk0OVowIzEhMB8GA1UEAwwYU2V0IExpdnJlIFVu
aXQgVGVzdCBMZWFmMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5Xnz
kboVdKPr3Cua3AN5OYB+3QW4Y5FmVqSJn/XdLt2Vu3SoWafV9wV91PlVxVKtP1bE
hJdYC4g463hTuN29jIHws6Fnkb1h1djDIqXyrzmB0qczVX9Mqogj8q6zKUSFOx+J
vNp5TqmGrALCw0bCLzgDMKWKgbC9DfHit+FNwV4A1DR8Grx8f/7dTuxPpN7gTaJI
+v2aLRP2agkOrSJemctm4Jh1lG+NESbcd8mpjXRGKHX8ag2M/jfuL9M2G1pfo1z4
KZuB5Au1LaoGx/lDjmhkLAqQtS3D7QDRbp0g3l0gbqPlaIT8O4RDdH8xSulOI2Ol
Wuh6qXZiz1eLqS/3cQIDAQABo2AwXjAdBgNVHQ4EFgQUSNrooaqeikh2egHyEXI2
owgyiPwwHwYDVR0jBBgwFoAUSNrooaqeikh2egHyEXI2owgyiPwwDAYDVR0TAQH/
BAIwADAOBgNVHQ8BAf8EBAMCBaAwDQYJKoZIhvcNAQELBQADggEBABbcMbbmeF3G
kcOAPfHHIX4Mw5ghs3TMNnL30b50WcOr9GqsBlrQsRVs3uwWwsca+R9aeQtkglk0
hUTbsDCgiyl93bkWAPcSlRzAzplSm3wM6KjJ6LqOjU5aCKQggvrwW6aFM1oIrufn
Kllz+bVvmL+7fqLrB7JpOh0UzAD01iD0inrUvvkzBk2FnRYCnLPJqPm2yJm/Kuvj
jTbmzoEf8WpFwc2neRs/rH3JrwoBiIsgTBjSzuy5J07vH/6tMYOWZIvZYiruPmQ7
7JyYNBhCGRaKEVVzUyDyDJRvbzJP/YDbP/Ow2qAwCmmUHwYmh5AN/ltZGDNTXaAC
JcGOg3JUVH0=
-----END CERTIFICATE-----
`;

const localDatabaseUrl =
  "postgresql://app_runtime:secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
const productionDatabaseUrl =
  "postgresql://app_runtime:secret@db.example.test:6543/postgres?options=-c%20role%3Dapp_dal";

let temporaryDirectory = "";
let caPath = "";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeCaBundle(contents: string) {
  writeFileSync(caPath, contents, "ascii");
  return readFileSync(caPath);
}

function productionEnvironment(bytes: Buffer, path = caPath) {
  return {
    APP_ENV: "production",
    DATABASE_TLS_CA_PATH: path,
    DATABASE_TLS_CA_SHA256: sha256(bytes),
    DATABASE_URL_APP_DAL: productionDatabaseUrl,
  };
}

describe("explicit PostgreSQL TLS connection configuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    temporaryDirectory = mkdtempSync(join(tmpdir(), "set-livre-postgres-tls-"));
    caPath = join(temporaryDirectory, "ca.pem");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it("keeps a local database explicitly without SSL", () => {
    expect(
      loadDalPostgresConnectionConfig({
        APP_ENV: "local",
        DATABASE_URL_APP_DAL: localDatabaseUrl,
      }),
    ).toEqual({
      connectionString: localDatabaseUrl,
      sessionRole: "app_runtime",
      ssl: false,
    });
  });

  it("rejects remote plaintext outside production and local CA configuration", () => {
    expect(() =>
      loadDalPostgresConnectionConfig({
        APP_ENV: "test",
        DATABASE_URL_APP_DAL: productionDatabaseUrl,
      }),
    ).toThrow("somente PostgreSQL local sem TLS");
    expect(() =>
      loadDalPostgresConnectionConfig({
        APP_ENV: "local",
        DATABASE_TLS_CA_PATH: caPath,
        DATABASE_URL_APP_DAL: localDatabaseUrl,
      }),
    ).toThrow("não aceita configuração de CA TLS");
  });

  it("requires both a physical CA path and its SHA-256 in production", () => {
    expect(() =>
      loadDalPostgresConnectionConfig({
        APP_ENV: "production",
        DATABASE_URL_APP_DAL: productionDatabaseUrl,
      }),
    ).toThrow("caminho físico");
    expect(() =>
      loadDalPostgresConnectionConfig({
        APP_ENV: "production",
        DATABASE_TLS_CA_PATH: caPath,
        DATABASE_URL_APP_DAL: productionDatabaseUrl,
      }),
    ).toThrow("SHA-256");
  });

  it("returns the exact verified CA bytes with strict peer verification", () => {
    const bytes = writeCaBundle(testCaCertificate);

    expect(loadDalPostgresConnectionConfig(productionEnvironment(bytes))).toEqual({
      connectionString: productionDatabaseUrl,
      sessionRole: "app_runtime",
      ssl: { ca: bytes, rejectUnauthorized: true },
    });
  });

  it("rejects a CA path redirected through a symlinked directory", () => {
    const physicalDirectory = join(temporaryDirectory, "physical");
    const linkedDirectory = join(temporaryDirectory, "linked");
    mkdirSync(physicalDirectory);
    caPath = join(physicalDirectory, "ca.pem");
    const bytes = writeCaBundle(testCaCertificate);
    symlinkSync(
      physicalDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      loadDalPostgresConnectionConfig(
        productionEnvironment(bytes, join(linkedDirectory, "ca.pem")),
      ),
    ).toThrow("symlink");
  });

  it("rejects a hash that does not match the exact file bytes", () => {
    writeCaBundle(testCaCertificate);

    expect(() =>
      loadDalPostgresConnectionConfig({
        APP_ENV: "production",
        DATABASE_TLS_CA_PATH: caPath,
        DATABASE_TLS_CA_SHA256: "0".repeat(64),
        DATABASE_URL_APP_DAL: productionDatabaseUrl,
      }),
    ).toThrow("não corresponde aos bytes lidos");
  });

  it("rejects private keys and non-certificate content even with an exact hash", () => {
    for (const contents of [
      `${testCaCertificate}-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n`,
      `${testCaCertificate}unexpected-content\n`,
    ]) {
      const bytes = writeCaBundle(contents);
      expect(() => loadDalPostgresConnectionConfig(productionEnvironment(bytes))).toThrow();
    }
  });

  it("rejects a valid PEM certificate that is not a CA", () => {
    const bytes = writeCaBundle(testLeafCertificate);

    expect(() => loadDalPostgresConnectionConfig(productionEnvironment(bytes))).toThrow("não é CA");
  });

  it.each(["2020-01-01T00:00:00.000Z", "2040-01-01T00:00:00.000Z"])(
    "rejects a CA certificate outside its validity at %s",
    (now) => {
      vi.setSystemTime(new Date(now));
      const bytes = writeCaBundle(testCaCertificate);

      expect(() => loadDalPostgresConnectionConfig(productionEnvironment(bytes))).toThrow(
        "fora da vigência",
      );
    },
  );
});
