import "server-only";

import { identityEmailSchema } from "@set-livre/contracts";
import { z } from "zod";

import { backofficeAuthCookieName } from "@/lib/supabase/config";

const claimsSchema = z.object({
  email: identityEmailSchema,
  exp: z.number().int().positive().max(8_640_000_000_000),
  session_id: z.uuid(),
  sub: z.uuid(),
});

export type BackofficeAuthContext = Readonly<{
  authExpiresAt: string;
  authSessionId: string;
  email: string;
  userId: string;
}>;

export type BackofficeCookieStore = Readonly<{
  delete: (name: string) => unknown;
  getAll: () => readonly { name: string }[];
}>;

export type BackofficeSupabaseAuth = Readonly<{
  getClaims: (jwt?: string) => Promise<{
    data: { claims?: unknown } | null;
    error: unknown;
  }>;
  getSession: () => Promise<{
    data: { session: unknown | null };
    error: unknown;
  }>;
  signOut: (options: { scope: "local" }) => Promise<{ error: unknown }>;
}>;

export function parseBackofficeAuthContext(claims: unknown): BackofficeAuthContext | undefined {
  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) return undefined;
  return {
    authExpiresAt: new Date(parsed.data.exp * 1_000).toISOString(),
    authSessionId: parsed.data.session_id,
    email: parsed.data.email,
    userId: parsed.data.sub,
  };
}

export function backofficeAuthCookieNames(cookieStore: Pick<BackofficeCookieStore, "getAll">) {
  let cookies: readonly { name: string }[];
  try {
    cookies = cookieStore.getAll();
  } catch {
    return [];
  }
  return cookies
    .map((cookie) => cookie.name)
    .filter((name) => {
      const chunk = name.startsWith(`${backofficeAuthCookieName}.`)
        ? name.slice(backofficeAuthCookieName.length + 1)
        : undefined;
      return (
        name === backofficeAuthCookieName ||
        (chunk !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(chunk))
      );
    });
}

export function clearBackofficeAuthCookies(cookieStore: BackofficeCookieStore) {
  for (const name of backofficeAuthCookieNames(cookieStore)) {
    try {
      cookieStore.delete(name);
    } catch {
      // A limpeza continua para os demais chunks canônicos.
    }
  }
}

export async function signOutBackofficeLocally(auth: BackofficeSupabaseAuth) {
  let providerError: unknown = null;
  try {
    providerError = (await auth.signOut({ scope: "local" })).error;
  } catch (error) {
    providerError = error;
  }
  if (providerError === null) return;

  try {
    const local = await auth.getSession();
    if (local.error === null && local.data.session === null) return;
  } catch {
    // Sem prova de remoção, o logout permanece inconclusivo.
  }
  throw new Error("Não foi possível encerrar a sessão no provedor.");
}

export async function discardBackofficeSessionBestEffort(input: {
  auth: BackofficeSupabaseAuth;
  cookieStore: BackofficeCookieStore;
}) {
  try {
    await signOutBackofficeLocally(input.auth);
  } catch {
    // A binding do banco será fechada pelo chamador quando existir.
  }
  clearBackofficeAuthCookies(input.cookieStore);
}
