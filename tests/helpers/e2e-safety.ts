import { Buffer } from "node:buffer";

import { z } from "zod";

const safeEnvironmentSchema = z.object({
  adminDatabaseUrl: z.url(),
  backofficeBaseUrl: z.url(),
  backofficeRuntimeUnlockKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  databaseMarker: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  dalDatabaseUrl: z.url(),
  explicitLocalPermission: z.literal("1"),
  publicBaseUrl: z.url(),
  supabaseAnonKey: z.string().min(1).max(8_192),
  supabaseSecretKey: z.string().min(1).max(8_192),
  supabaseUrl: z.url(),
});

type SafeEnvironmentInput = {
  adminDatabaseUrl: string | undefined;
  backofficeBaseUrl: string | undefined;
  backofficeRuntimeUnlockKey: string | undefined;
  databaseMarker: string | undefined;
  dalDatabaseUrl: string | undefined;
  explicitLocalPermission: string | undefined;
  publicBaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  supabaseSecretKey: string | undefined;
  supabaseUrl: string | undefined;
};

const publishableKeyPattern = /^sb_publishable_[A-Za-z0-9_-]{12,}$/u;
const jwtSegmentPattern = /^[A-Za-z0-9_-]+$/u;

function assertPublicSupabaseKey(value: string) {
  if (publishableKeyPattern.test(value)) return;

  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !jwtSegmentPattern.test(segment))) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY não é uma chave pública Supabase válida.");
  }

  try {
    const payload = z
      .object({ role: z.literal("anon") })
      .passthrough()
      .parse(JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8")));
    if (payload.role !== "anon") throw new Error("role inesperada");
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY precisa usar a role pública anon.");
  }
}

function assertLocalServerSupabaseKey(value: string) {
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !jwtSegmentPattern.test(segment))) {
    throw new Error("SUPABASE_SECRET_KEY não é uma chave server-only local válida.");
  }

  try {
    const payload = z
      .object({ role: z.literal("service_role") })
      .passthrough()
      .parse(JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8")));
    if (payload.role !== "service_role") throw new Error("role inesperada");
  } catch {
    throw new Error("SUPABASE_SECRET_KEY local precisa usar a role service_role.");
  }
}

function rawUrlHostname(value: string): string | undefined {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) return undefined;

  const authorityStart = schemeSeparator + 3;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd =
    authorityEndOffset === -1 ? value.length : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) {
    const closingBracket = hostAndPort.indexOf("]");
    return closingBracket === -1 ? undefined : hostAndPort.slice(0, closingBracket + 1);
  }

  const portSeparator = hostAndPort.lastIndexOf(":");
  return portSeparator === -1 ? hostAndPort : hostAndPort.slice(0, portSeparator);
}

function parseLiteralLocalIpv4Url(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} é inválida.`);
  }

  if (parsed.hostname !== "127.0.0.1" || rawUrlHostname(value) !== "127.0.0.1") {
    throw new Error(`${label} precisa usar o host IPv4 literal 127.0.0.1.`);
  }
  return parsed;
}

function assertLocalUrl(
  value: string,
  label: string,
  expectedPort: string,
  allowedProtocols: ReadonlySet<string>,
) {
  const parsed = parseLiteralLocalIpv4Url(value, label);

  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(`${label} usa protocolo não permitido: ${parsed.protocol}.`);
  }

  if (parsed.port !== expectedPort) {
    throw new Error(
      `${label} precisa usar a porta local ${expectedPort}; recebido ${parsed.port}.`,
    );
  }

  return parsed;
}

function assertBareOrigin(parsed: URL, label: string) {
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} precisa ser uma origem local sem credenciais, path, query ou hash.`);
  }
}

export function assertSafeE2EEnvironment(input: SafeEnvironmentInput) {
  const parsed = safeEnvironmentSchema.parse(input);
  assertPublicSupabaseKey(parsed.supabaseAnonKey);
  assertLocalServerSupabaseKey(parsed.supabaseSecretKey);

  const publicBaseUrl = assertLocalUrl(
    parsed.publicBaseUrl,
    "E2E_BASE_URL",
    "3000",
    new Set(["http:"]),
  );
  const backofficeBaseUrl = assertLocalUrl(
    parsed.backofficeBaseUrl,
    "E2E_BACKOFFICE_URL",
    "3001",
    new Set(["http:"]),
  );
  const supabaseUrl = assertLocalUrl(
    parsed.supabaseUrl,
    "NEXT_PUBLIC_SUPABASE_URL",
    "54321",
    new Set(["http:"]),
  );
  assertBareOrigin(publicBaseUrl, "E2E_BASE_URL");
  assertBareOrigin(backofficeBaseUrl, "E2E_BACKOFFICE_URL");
  assertBareOrigin(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL");

  const adminDatabaseUrl = assertLocalUrl(
    parsed.adminDatabaseUrl,
    "E2E_DATABASE_URL",
    "54322",
    new Set(["postgres:", "postgresql:"]),
  );
  if (
    decodeURIComponent(adminDatabaseUrl.username) !== "postgres" ||
    adminDatabaseUrl.password === "" ||
    adminDatabaseUrl.pathname !== "/postgres" ||
    adminDatabaseUrl.search !== "" ||
    adminDatabaseUrl.hash !== ""
  ) {
    throw new Error("E2E_DATABASE_URL não usa a identidade administrativa local esperada.");
  }
  const dalDatabaseUrl = assertLocalUrl(
    parsed.dalDatabaseUrl,
    "DATABASE_URL_APP_DAL",
    "54322",
    new Set(["postgres:", "postgresql:"]),
  );
  if (
    dalDatabaseUrl.username !== "app_runtime_local" ||
    dalDatabaseUrl.password === "" ||
    dalDatabaseUrl.pathname !== "/postgres" ||
    dalDatabaseUrl.hash !== "" ||
    dalDatabaseUrl.searchParams.size !== 1 ||
    dalDatabaseUrl.searchParams.get("options") !== "-c role=app_dal"
  ) {
    throw new Error("DATABASE_URL_APP_DAL não usa a identidade DAL local restrita.");
  }

  return parsed;
}
