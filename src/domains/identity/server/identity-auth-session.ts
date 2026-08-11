import "server-only";

import { combineChunks, stringFromBase64URL } from "@supabase/ssr";
import { z } from "zod";

import { handleLogoutProviderError } from "./identity-provider-errors";

const authSessionContextSchema = z.object({
  exp: z.number().int().positive().max(8_640_000_000_000),
  session_id: z.uuid(),
  sub: z.uuid(),
});

export type IdentityCookieStore = Readonly<{
  delete: (name: string) => unknown;
  getAll: () => readonly { name: string; value?: string }[];
}>;

export type IdentitySupabaseAuth = Readonly<{
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

export function parseAuthSessionContext(claims: unknown) {
  const parsed = authSessionContextSchema.safeParse(claims);
  if (!parsed.success) {
    return undefined;
  }
  return {
    authExpiresAt: new Date(parsed.data.exp * 1_000).toISOString(),
    authExpiresAtEpochSeconds: parsed.data.exp,
    authSessionId: parsed.data.session_id,
    userId: parsed.data.sub,
  };
}

export function supabaseAuthCookieNames(
  cookieStore: Pick<IdentityCookieStore, "getAll">,
  supabaseOrigin: string,
) {
  let projectReference: string | undefined;
  try {
    projectReference = new URL(supabaseOrigin).hostname.split(".")[0];
  } catch {
    return [];
  }
  if (projectReference === undefined || projectReference === "") {
    return [];
  }
  const storageKey = `sb-${projectReference}-auth-token`;
  let currentCookies: readonly { name: string }[];
  try {
    currentCookies = cookieStore.getAll();
  } catch {
    return [];
  }
  return currentCookies
    .map((cookie) => cookie.name)
    .filter((name) => {
      const chunk = name.startsWith(`${storageKey}.`)
        ? name.slice(storageKey.length + 1)
        : undefined;
      return name === storageKey || (chunk !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(chunk));
    });
}

export async function readSupabaseAccessTokenFromCookies(
  cookieStore: Pick<IdentityCookieStore, "getAll">,
  supabaseOrigin: string,
) {
  let storageKey: string;
  try {
    const projectReference = new URL(supabaseOrigin).hostname.split(".")[0];
    if (projectReference === undefined || projectReference === "") {
      return undefined;
    }
    storageKey = `sb-${projectReference}-auth-token`;
  } catch {
    return undefined;
  }

  let cookiesByName: ReadonlyMap<string, string>;
  try {
    cookiesByName = new Map(
      cookieStore
        .getAll()
        .filter(
          (cookie): cookie is { name: string; value: string } => typeof cookie.value === "string",
        )
        .map((cookie) => [cookie.name, cookie.value]),
    );
  } catch {
    return undefined;
  }

  const storedSession = await combineChunks(storageKey, (name) => cookiesByName.get(name));
  if (storedSession === null) {
    return undefined;
  }
  try {
    const decodedSession = storedSession.startsWith("base64-")
      ? stringFromBase64URL(storedSession.slice("base64-".length))
      : storedSession;
    const parsed = z
      .object({ access_token: z.string().min(1) })
      .safeParse(JSON.parse(decodedSession));
    return parsed.success ? parsed.data.access_token : undefined;
  } catch {
    return undefined;
  }
}

function clearSupabaseAuthCookies(cookieStore: IdentityCookieStore, supabaseOrigin: string) {
  for (const name of supabaseAuthCookieNames(cookieStore, supabaseOrigin)) {
    try {
      cookieStore.delete(name);
    } catch {
      // Uma falha pontual não impede a tentativa de apagar os demais chunks.
    }
  }
}

export function deleteCookieBestEffort(
  cookieStore: Pick<IdentityCookieStore, "delete">,
  name: string,
) {
  try {
    cookieStore.delete(name);
  } catch {
    // A limpeza das demais credenciais conhecidas ainda precisa continuar.
  }
}

export async function signOutLocalOrProveAbsent(auth: IdentitySupabaseAuth) {
  let providerError: unknown = null;
  try {
    const result = await auth.signOut({ scope: "local" });
    providerError = result.error;
  } catch (error) {
    providerError = error;
  }
  if (providerError === null) {
    return;
  }

  let localSessionWasRemoved = false;
  try {
    const localState = await auth.getSession();
    localSessionWasRemoved = localState.error === null && localState.data.session === null;
  } catch {
    // Sem prova local de remoção, a resposta permanece fail-closed.
  }
  if (!localSessionWasRemoved) {
    handleLogoutProviderError(providerError);
  }
}

export async function signOutLocalAndClearExactAuthCookies(input: {
  auth: IdentitySupabaseAuth;
  cookieStore: IdentityCookieStore;
  supabaseOrigin: string;
}) {
  let signOutError: unknown;
  let signOutFailed = false;
  try {
    await signOutLocalOrProveAbsent(input.auth);
  } catch (error) {
    signOutError = error;
    signOutFailed = true;
  }
  clearSupabaseAuthCookies(input.cookieStore, input.supabaseOrigin);
  if (signOutFailed) {
    throw signOutError;
  }
}

export async function discardIdentitySessionBestEffort(input: {
  auth: IdentitySupabaseAuth;
  cookieStore: IdentityCookieStore;
  supabaseOrigin: string;
}) {
  try {
    await signOutLocalAndClearExactAuthCookies(input);
  } catch {
    // O erro causal do fluxo permanece autoritativo e redigido.
  }
}
