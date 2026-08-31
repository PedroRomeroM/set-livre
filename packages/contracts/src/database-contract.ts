import { z } from "zod";

export const databaseMigrationHead = "20260831021612" as const;

const privilegedRoleNames = new Set(["postgres", "service_role", "supabase_admin"]);
const roleNamePattern = /^[a-z_][a-z0-9_]{0,62}$/u;
const supabasePoolerHostPattern = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/u;
const supabasePoolerUserPattern = /^(?<role>[a-z_][a-z0-9_]{0,62})\.(?<projectRef>[a-z]{20})$/u;
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

  const poolerUser = supabasePoolerUserPattern.exec(username);
  const sessionRole = poolerUser?.groups?.role ?? username;
  if (!roleNamePattern.test(sessionRole) || privilegedRoleNames.has(sessionRole)) {
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

  const isLoopback = parsed.hostname === "127.0.0.1";
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (!isLoopback && (sslModes.length !== 1 || sslModes[0] !== "verify-full")) {
    context.addIssue({ code: "custom", message: "A conexão DAL remota exige TLS verify-full." });
  }
  if (poolerUser !== null) {
    if (!supabasePoolerHostPattern.test(parsed.hostname) || parsed.port !== "5432") {
      context.addIssue({
        code: "custom",
        message: "A conexão Supavisor DAL exige o pooler oficial em modo de sessão.",
      });
    }
  } else if (parsed.hostname.endsWith(".pooler.supabase.com")) {
    context.addIssue({
      code: "custom",
      message: "A conexão Supavisor DAL exige o project ref no usuário.",
    });
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
  const username = decodeURIComponent(new URL(connectionString).username);
  const poolerUser = supabasePoolerUserPattern.exec(username);
  return {
    connectionString,
    projectRef: poolerUser?.groups?.projectRef,
    sessionRole: poolerUser?.groups?.role ?? username,
  };
}
