import { z } from "zod";

export const databaseMigrationHead = "20260819000100" as const;

const privilegedRoleNames = new Set(["postgres", "service_role", "supabase_admin"]);
const authorityOverrideParameters = new Set([
  "database",
  "host",
  "password",
  "port",
  "role",
  "user",
  "username",
]);
const connectionStringTlsParameters = new Set(["sslcert", "sslkey", "sslmode", "sslrootcert"]);

const dalDatabaseUrlSchema = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    context.addIssue({ code: "custom", message: "A conexão DAL exige protocolo PostgreSQL." });
  }

  let username = "";
  let password = "";
  let database = "";
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    context.addIssue({ code: "custom", message: "A conexão DAL possui encoding inválido." });
    return;
  }

  if (username === "" || privilegedRoleNames.has(username)) {
    context.addIssue({ code: "custom", message: "A conexão DAL usa uma role privilegiada." });
  }
  if (password === "") {
    context.addIssue({ code: "custom", message: "A conexão DAL exige senha." });
  }
  if (database === "" || database.includes("/")) {
    context.addIssue({ code: "custom", message: "A conexão DAL exige um banco explícito." });
  }
  if (parsed.hash !== "") {
    context.addIssue({ code: "custom", message: "A conexão DAL não aceita fragmento." });
  }

  const options = parsed.searchParams.getAll("options");
  if (options.length !== 1 || options[0] !== "-c role=app_dal") {
    context.addIssue({ code: "custom", message: "A conexão DAL precisa assumir app_dal." });
  }
  for (const parameter of authorityOverrideParameters) {
    if (parsed.searchParams.has(parameter)) {
      context.addIssue({
        code: "custom",
        message: "A conexão DAL tenta sobrescrever sua identidade na query.",
      });
    }
  }
  for (const parameter of connectionStringTlsParameters) {
    if (parsed.searchParams.has(parameter)) {
      context.addIssue({
        code: "custom",
        message: "A conexão DAL não aceita parâmetros TLS na URL.",
      });
    }
  }
});

export function parseDalDatabaseUrl(value: unknown) {
  const connectionString = dalDatabaseUrlSchema.parse(value);
  return {
    connectionString,
    sessionRole: decodeURIComponent(new URL(connectionString).username),
  };
}
