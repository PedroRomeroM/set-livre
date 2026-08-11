import { z } from "zod";

import { parseLiteralLocalIpv4Url } from "../../scripts/local-network-contract";

const safeEnvironmentSchema = z.object({
  adminDatabaseUrl: z.url(),
  backofficeBaseUrl: z.url(),
  databaseMarker: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  dalDatabaseUrl: z.url(),
  explicitLocalPermission: z.literal("1"),
  publicBaseUrl: z.url(),
  supabaseUrl: z.url(),
});

type SafeEnvironmentInput = {
  adminDatabaseUrl: string | undefined;
  backofficeBaseUrl: string | undefined;
  databaseMarker: string | undefined;
  dalDatabaseUrl: string | undefined;
  explicitLocalPermission: string | undefined;
  publicBaseUrl: string | undefined;
  supabaseUrl: string | undefined;
};

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
