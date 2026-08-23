import "server-only";

import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { parseDalDatabaseUrl } from "../database-contract";

const maximumCaBundleBytes = 1024 * 1024;
const localDatabaseHostnames = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const certificateBlockPattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;
const privateKeyBlockPattern = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const asciiPemPattern = /^[\t\n\r\x20-\x7e]*$/u;

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "local", "production", "test"]),
  DATABASE_TLS_CA_PATH: z.string().min(1).optional(),
  DATABASE_TLS_CA_SHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  DATABASE_URL_APP_DAL: z.string(),
});

class PostgresTlsConfigurationError extends Error {}

function configurationError(message: string) {
  return new PostgresTlsConfigurationError(message);
}

function normalizedPathIdentity(value: string) {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasSameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readPhysicalCaBundle(caPath: string) {
  try {
    if (
      !isAbsolute(caPath) ||
      normalizedPathIdentity(resolve(caPath)) !== normalizedPathIdentity(caPath)
    ) {
      throw configurationError("A CA PostgreSQL exige um caminho físico absoluto e canônico.");
    }

    const pathIdentity = lstatSync(caPath);
    if (pathIdentity.isSymbolicLink() || !pathIdentity.isFile()) {
      throw configurationError("A CA PostgreSQL precisa ser um arquivo físico regular.");
    }
    if (pathIdentity.size === 0 || pathIdentity.size > maximumCaBundleBytes) {
      throw configurationError("O tamanho do bundle CA PostgreSQL é inválido.");
    }

    const physicalPath = realpathSync.native(caPath);
    if (normalizedPathIdentity(physicalPath) !== normalizedPathIdentity(caPath)) {
      throw configurationError(
        "A CA PostgreSQL não aceita symlink ou redirecionamento de caminho.",
      );
    }

    const descriptor = openSync(caPath, "r");
    try {
      const openedIdentity = fstatSync(descriptor);
      if (!openedIdentity.isFile() || !hasSameFileIdentity(pathIdentity, openedIdentity)) {
        throw configurationError("A identidade física da CA PostgreSQL mudou durante a leitura.");
      }

      const bytes = readFileSync(descriptor);
      const finalDescriptorIdentity = fstatSync(descriptor);
      const finalPathIdentity = lstatSync(caPath);
      if (
        !hasSameFileIdentity(openedIdentity, finalDescriptorIdentity) ||
        !hasSameFileIdentity(openedIdentity, finalPathIdentity) ||
        openedIdentity.size !== finalDescriptorIdentity.size ||
        openedIdentity.mtimeMs !== finalDescriptorIdentity.mtimeMs ||
        bytes.length !== finalDescriptorIdentity.size
      ) {
        throw configurationError("A CA PostgreSQL mudou durante a leitura.");
      }
      if (normalizedPathIdentity(realpathSync.native(caPath)) !== normalizedPathIdentity(caPath)) {
        throw configurationError("A CA PostgreSQL mudou de caminho durante a leitura.");
      }

      return bytes;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof PostgresTlsConfigurationError) {
      throw error;
    }
    throw configurationError("Não foi possível ler a CA PostgreSQL do caminho físico configurado.");
  }
}

function assertExactSha256(bytes: Buffer, expectedSha256: string) {
  const actualDigest = createHash("sha256").update(bytes).digest();
  const expectedDigest = Buffer.from(expectedSha256, "hex");
  if (!timingSafeEqual(actualDigest, expectedDigest)) {
    throw configurationError("O SHA-256 da CA PostgreSQL não corresponde aos bytes lidos.");
  }
}

function assertCurrentCaCertificateBundle(bytes: Buffer) {
  let pem: string;
  try {
    pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError("A CA PostgreSQL precisa usar PEM UTF-8 válido.");
  }

  if (!asciiPemPattern.test(pem) || privateKeyBlockPattern.test(pem)) {
    throw configurationError("A CA PostgreSQL aceita somente certificados PEM, nunca private key.");
  }

  const certificateBlocks = [...pem.matchAll(certificateBlockPattern)].map(([block]) => block);
  const remainingContent = pem.replace(certificateBlockPattern, "").trim();
  if (certificateBlocks.length === 0 || remainingContent !== "") {
    throw configurationError(
      "A CA PostgreSQL precisa conter somente um bundle PEM de certificados.",
    );
  }

  const now = Date.now();
  for (const block of certificateBlocks) {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      throw configurationError("A CA PostgreSQL contém um certificado PEM inválido.");
    }

    if (!certificate.ca) {
      throw configurationError("A CA PostgreSQL contém um certificado que não é CA.");
    }
    if (certificate.validFromDate.getTime() > now || certificate.validToDate.getTime() < now) {
      throw configurationError("A CA PostgreSQL contém um certificado fora da vigência.");
    }
  }
}

export type DalPostgresConnectionConfig = Readonly<{
  connectionString: string;
  sessionRole: string;
  ssl:
    | false
    | Readonly<{
        ca: Buffer;
        rejectUnauthorized: true;
      }>;
}>;

export function loadDalPostgresConnectionConfig(source: unknown): DalPostgresConnectionConfig {
  const environment = environmentSchema.parse(source);
  const database = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  const hostname = new URL(database.connectionString).hostname.toLowerCase();
  const isLocalDatabase = localDatabaseHostnames.has(hostname);

  if (environment.APP_ENV !== "production") {
    if (!isLocalDatabase) {
      throw configurationError("Ambiente não produtivo aceita somente PostgreSQL local sem TLS.");
    }
    if (
      environment.DATABASE_TLS_CA_PATH !== undefined ||
      environment.DATABASE_TLS_CA_SHA256 !== undefined
    ) {
      throw configurationError("PostgreSQL local não aceita configuração de CA TLS.");
    }
    return { ...database, ssl: false };
  }

  if (isLocalDatabase) {
    throw configurationError("Produção exige um destino PostgreSQL remoto com TLS explícito.");
  }
  if (environment.DATABASE_TLS_CA_PATH === undefined) {
    throw configurationError("Produção exige o caminho físico da CA PostgreSQL.");
  }
  if (environment.DATABASE_TLS_CA_SHA256 === undefined) {
    throw configurationError("Produção exige o SHA-256 da CA PostgreSQL.");
  }

  const ca = readPhysicalCaBundle(environment.DATABASE_TLS_CA_PATH);
  assertExactSha256(ca, environment.DATABASE_TLS_CA_SHA256);
  assertCurrentCaCertificateBundle(ca);

  return {
    ...database,
    ssl: { ca, rejectUnauthorized: true },
  };
}
