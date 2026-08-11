import { resolve } from "node:path";

import { readOptionalE2EEnvironmentFile } from "./e2e-environment-file";
import { assertSafeE2EEnvironment } from "./e2e-safety";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const localEnvironment = readOptionalE2EEnvironmentFile(repositoryRoot);
const environmentValue = (name: string) => process.env[name] ?? localEnvironment[name];

export const safeE2EEnvironment = assertSafeE2EEnvironment({
  adminDatabaseUrl: environmentValue("E2E_DATABASE_URL"),
  backofficeBaseUrl: environmentValue("E2E_BACKOFFICE_URL"),
  databaseMarker: environmentValue("E2E_DATABASE_MARKER"),
  dalDatabaseUrl: environmentValue("DATABASE_URL_APP_DAL"),
  explicitLocalPermission: environmentValue("E2E_ALLOW_LOCAL"),
  publicBaseUrl: environmentValue("E2E_BASE_URL"),
  supabaseUrl: environmentValue("NEXT_PUBLIC_SUPABASE_URL"),
});
