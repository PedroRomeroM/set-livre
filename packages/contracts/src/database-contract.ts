import { z } from "zod";

export const databaseMigrationHead = "20260905190840" as const;
export const databaseCommandPoolTimeouts = Object.freeze({
  queryTimeoutMs: 3_000,
  statementTimeoutMs: 2_000,
});
export const databaseReadinessPoolTimeouts = Object.freeze({
  queryTimeoutMs: 2_000,
  statementTimeoutMs: 1_000,
});
const databaseProductionPoolerHost = "aws-0-sa-east-1.pooler.supabase.com" as const;
const databaseProductionProjectRef = "oirvvnojgkzdppkdvhej" as const;

const localRuntimeRole = "app_runtime_local";
const productionRuntimeRole = "app_runtime_production";
const productionPoolerUser = `${productionRuntimeRole}.${databaseProductionProjectRef}`;
const allowedConnectionParameters = new Set(["options", "sslmode"]);
const rawControlCharacterPattern = /[\u0000-\u001f\u007f]/u;
const rawEnvironmentFileSyntaxPattern = /['"\\ ]/u;

const normalizedDalDatabaseUrlSchema = z.url().superRefine((value, context) => {
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

  if (password === "") {
    context.addIssue({ code: "custom", message: "A conexão DAL exige senha." });
  }
  if (database === "" || database.includes("/")) {
    context.addIssue({ code: "custom", message: "A conexão DAL exige um banco explícito." });
  }
  if (parsed.hash !== "") {
    context.addIssue({ code: "custom", message: "A conexão DAL não aceita fragmento." });
  }

  const isLocal = parsed.hostname === "127.0.0.1";
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (isLocal) {
    if (username !== localRuntimeRole || parsed.port !== "54322" || database !== "postgres") {
      context.addIssue({
        code: "custom",
        message: "A conexão DAL local não usa a identidade e as coordenadas canônicas.",
      });
    }
    if (sslModes.length !== 0) {
      context.addIssue({ code: "custom", message: "A conexão DAL local não aceita sslmode." });
    }
  } else {
    if (
      username !== productionPoolerUser ||
      parsed.hostname !== databaseProductionPoolerHost ||
      parsed.port !== "5432" ||
      database !== "postgres"
    ) {
      context.addIssue({
        code: "custom",
        message: "A conexão DAL remota não usa a identidade e as coordenadas canônicas.",
      });
    }
    if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
      context.addIssue({ code: "custom", message: "A conexão DAL remota exige TLS verify-full." });
    }
  }

  const options = parsed.searchParams.getAll("options");
  if (options.length !== 1 || options[0] !== "-c role=app_dal") {
    context.addIssue({ code: "custom", message: "A conexão DAL precisa assumir app_dal." });
  }
  for (const parameter of parsed.searchParams.keys()) {
    if (!allowedConnectionParameters.has(parameter)) {
      context.addIssue({
        code: "custom",
        message: "A conexão DAL contém parâmetro não autorizado.",
      });
    }
  }
});
const dalDatabaseUrlSchema = z
  .string()
  .refine((value) => !rawControlCharacterPattern.test(value), {
    message: "A conexão DAL contém caractere de controle não autorizado.",
  })
  .refine((value) => !rawEnvironmentFileSyntaxPattern.test(value), {
    message: "A conexão DAL contém caractere que exige percent-encoding.",
  })
  .pipe(normalizedDalDatabaseUrlSchema);

export function parseDalDatabaseUrl(value: unknown) {
  const connectionString = dalDatabaseUrlSchema.parse(value);
  const parsed = new URL(connectionString);
  const local = parsed.hostname === "127.0.0.1";
  return {
    connectionString,
    projectRef: local ? undefined : databaseProductionProjectRef,
    sessionRole: local ? localRuntimeRole : productionRuntimeRole,
  };
}
