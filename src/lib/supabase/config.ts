import { z } from "zod";
import { Buffer } from "node:buffer";

const supabaseEnvironmentSchema = z.object({
  APP_ENV: z.enum(["development", "local", "production", "test"]),
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
});

const modernSupabaseSecretKeySchema = z
  .string()
  .min(1)
  .max(8_192)
  .regex(
    /^sb_secret_[A-Za-z0-9_-]{12,}$/u,
    "SUPABASE_SECRET_KEY precisa ser uma chave secreta server-only moderna.",
  );

const localLegacyServiceRoleKeySchema = z
  .string()
  .min(1)
  .max(8_192)
  .superRefine((value, context) => {
    const segments = value.split(".");
    try {
      if (
        segments.length !== 3 ||
        segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment)) ||
        z
          .object({ role: z.literal("service_role") })
          .passthrough()
          .parse(JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8"))).role !==
          "service_role"
      ) {
        throw new Error("role inesperada");
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "SUPABASE_SECRET_KEY precisa ser uma chave secreta server-only válida.",
      });
    }
  });

export function readSupabaseEnvironment() {
  const environment = supabaseEnvironmentSchema.parse(process.env);
  const appUrl = new URL(environment.NEXT_PUBLIC_APP_URL);
  const supabaseUrl = new URL(environment.NEXT_PUBLIC_SUPABASE_URL);

  if (appUrl.origin !== environment.NEXT_PUBLIC_APP_URL || appUrl.pathname !== "/") {
    throw new Error("NEXT_PUBLIC_APP_URL precisa ser uma origem sem path, query ou fragmento.");
  }
  if (supabaseUrl.origin !== environment.NEXT_PUBLIC_SUPABASE_URL || supabaseUrl.pathname !== "/") {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL precisa ser uma origem sem path, query ou fragmento.",
    );
  }

  const isLocalRuntime = environment.APP_ENV === "local" || environment.APP_ENV === "test";
  if (
    isLocalRuntime &&
    (environment.NEXT_PUBLIC_APP_URL !== "http://127.0.0.1:3000" ||
      environment.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321")
  ) {
    throw new Error("O runtime local de Auth exige as origens HTTP IPv4 literais documentadas.");
  }
  if (!isLocalRuntime && (appUrl.protocol !== "https:" || supabaseUrl.protocol !== "https:")) {
    throw new Error("O runtime não local de Auth exige origens HTTPS para a aplicação e Supabase.");
  }

  return {
    anonKey: environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    appOrigin: appUrl.origin,
    cookieOptions: {
      httpOnly: true,
      path: "/",
      sameSite: "lax" as const,
      secure: !isLocalRuntime,
    },
    supabaseOrigin: supabaseUrl.origin,
  };
}

export function readTrustedSupabaseEnvironment() {
  const environment = readSupabaseEnvironment();
  const localRuntime = process.env.APP_ENV === "local" || process.env.APP_ENV === "test";
  const secretKey = localRuntime
    ? z
        .union([modernSupabaseSecretKeySchema, localLegacyServiceRoleKeySchema])
        .parse(process.env.SUPABASE_SECRET_KEY)
    : modernSupabaseSecretKeySchema.parse(process.env.SUPABASE_SECRET_KEY);
  return {
    secretKey,
    supabaseOrigin: environment.supabaseOrigin,
  };
}
