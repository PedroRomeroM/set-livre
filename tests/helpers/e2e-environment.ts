import { resolve } from "node:path";

import { localE2EEnvironmentValue, readOptionalE2EEnvironmentFile } from "./e2e-environment-file";
import { assertSafeE2EEnvironment } from "./e2e-safety";

type SafeE2EEnvironment = ReturnType<typeof assertSafeE2EEnvironment>;

let cachedSafeE2EEnvironment: SafeE2EEnvironment | undefined;

export function readSafeE2EEnvironment() {
  if (cachedSafeE2EEnvironment !== undefined) return cachedSafeE2EEnvironment;

  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const localEnvironment = readOptionalE2EEnvironmentFile(repositoryRoot);
  const environmentValue = (name: string) =>
    localE2EEnvironmentValue(localEnvironment, process.env, name);
  cachedSafeE2EEnvironment = assertSafeE2EEnvironment({
    adminDatabaseUrl: environmentValue("E2E_DATABASE_URL"),
    backofficeBaseUrl: environmentValue("E2E_BACKOFFICE_URL"),
    backofficeRuntimeUnlockKey: environmentValue("BACKOFFICE_RUNTIME_UNLOCK_KEY"),
    databaseMarker: environmentValue("E2E_DATABASE_MARKER"),
    dalDatabaseUrl: environmentValue("DATABASE_URL_APP_DAL"),
    explicitLocalPermission: environmentValue("E2E_ALLOW_LOCAL"),
    publicBaseUrl: environmentValue("E2E_BASE_URL"),
    supabaseAnonKey: environmentValue("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseSecretKey: environmentValue("SUPABASE_SECRET_KEY"),
    supabaseUrl: environmentValue("NEXT_PUBLIC_SUPABASE_URL"),
  });
  return cachedSafeE2EEnvironment;
}
