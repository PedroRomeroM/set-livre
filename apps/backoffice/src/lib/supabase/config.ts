import { z } from "zod";

export const backofficeAuthCookieName = "set-livre-backoffice-auth";

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "local", "production", "test"]),
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
});

export function readBackofficeSupabaseEnvironment() {
  const environment = environmentSchema.parse(process.env);
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
    (appUrl.origin !== "http://127.0.0.1:3001" || supabaseUrl.origin !== "http://127.0.0.1:54321")
  ) {
    throw new Error("O backoffice local exige as origens IPv4 literais documentadas.");
  }
  if (!isLocalRuntime && (appUrl.protocol !== "https:" || supabaseUrl.protocol !== "https:")) {
    throw new Error("O backoffice não local exige origens HTTPS.");
  }

  return {
    anonKey: environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    appOrigin: appUrl.origin,
    cookieOptions: {
      httpOnly: true,
      name: backofficeAuthCookieName,
      path: "/",
      sameSite: "strict" as const,
      secure: !isLocalRuntime,
    },
    environment: environment.APP_ENV,
    supabaseOrigin: supabaseUrl.origin,
  };
}
