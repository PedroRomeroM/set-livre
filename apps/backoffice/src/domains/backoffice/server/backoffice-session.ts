import "server-only";

import { backofficeSessionSchema, type BackofficeSession } from "@set-livre/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { z } from "zod";

import { BackofficeApiError } from "@/lib/server/api-route";
import {
  createBackofficeComponentSupabaseClient,
  createBackofficeRouteSupabaseClient,
  createBackofficeTransientSupabaseClient,
} from "@/lib/supabase/server";

import {
  clearBackofficeAuthCookies,
  discardBackofficeSessionBestEffort,
  parseBackofficeAuthContext,
  signOutBackofficeLocally,
  type BackofficeAuthContext,
} from "./auth-context";
import {
  closeBackofficeBinding,
  openBackofficeBinding,
  readBackofficeBinding,
  type BackofficeBinding,
} from "./backoffice-dal";

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

type BackofficeSupabaseClient = SupabaseClient;

function unauthenticatedSession(): BackofficeSession {
  return backofficeSessionSchema.parse({ authenticated: false });
}

function authenticatedSession(
  auth: BackofficeAuthContext,
  binding: BackofficeBinding,
): BackofficeSession {
  if (binding.scope !== auth.userId) {
    throw new Error("A binding administrativa não corresponde à identidade autenticada.");
  }
  return backofficeSessionSchema.parse({
    authenticated: true,
    email: auth.email,
    expiresAt: binding.expires_at,
    roles: binding.roles,
    scope: binding.scope,
    strongAuthenticationExpiresAt: binding.strong_authentication_expires_at,
  });
}

function isRejectedBinding(error: unknown) {
  const parsed = databaseErrorSchema.safeParse(error);
  return parsed.success && (parsed.data.code === "42501" || parsed.data.code === "22023");
}

async function readAuthContext(client: BackofficeSupabaseClient) {
  const claims = await client.auth.getClaims();
  return claims.error === null ? parseBackofficeAuthContext(claims.data?.claims) : undefined;
}

async function invalidateCurrentSession(
  client: BackofficeSupabaseClient,
  auth: BackofficeAuthContext | undefined,
) {
  const cookieStore = await cookies();
  if (auth !== undefined) {
    try {
      await closeBackofficeBinding(auth);
    } catch {
      // O provedor e os cookies ainda são invalidados para impedir continuidade local.
    }
  }
  await discardBackofficeSessionBestEffort({ auth: client.auth, cookieStore });
}

async function readBoundSession(client: BackofficeSupabaseClient) {
  const auth = await readAuthContext(client);
  if (auth === undefined) {
    clearBackofficeAuthCookies(await cookies());
    return undefined;
  }
  try {
    const binding = await readBackofficeBinding(auth);
    return { auth, session: authenticatedSession(auth, binding) };
  } catch (error) {
    if (!isRejectedBinding(error)) throw error;
    await invalidateCurrentSession(client, auth);
    return undefined;
  }
}

export async function readComponentBackofficeSession() {
  const state = await readBoundSession(await createBackofficeComponentSupabaseClient());
  return state?.session ?? unauthenticatedSession();
}

export async function readRouteBackofficeSession() {
  const route = await createBackofficeRouteSupabaseClient();
  const state = await readBoundSession(route.client);
  return { ...route, session: state?.session ?? unauthenticatedSession() };
}

export async function requireRouteBackofficeSession() {
  const route = await createBackofficeRouteSupabaseClient();
  const state = await readBoundSession(route.client);
  if (state === undefined || !state.session.authenticated) {
    throw new BackofficeApiError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
  }
  return { ...route, auth: state.auth, session: state.session };
}

function providerLoginError() {
  return new BackofficeApiError(401, "AUTH_INVALID", "E-mail ou senha inválidos.");
}

export async function loginBackoffice(payload: { email: string; password: string }) {
  const transient = createBackofficeTransientSupabaseClient();
  let signIn: Awaited<ReturnType<typeof transient.auth.signInWithPassword>>;
  try {
    signIn = await transient.auth.signInWithPassword(payload);
  } catch {
    throw providerLoginError();
  }
  if (signIn.error !== null || signIn.data.session === null) {
    throw providerLoginError();
  }

  const claims = await transient.auth.getClaims(signIn.data.session.access_token);
  const auth = claims.error === null ? parseBackofficeAuthContext(claims.data?.claims) : undefined;
  if (auth === undefined || auth.email !== payload.email) {
    await signOutBackofficeLocally(transient.auth);
    throw new BackofficeApiError(
      503,
      "AUTH_SESSION_RECHECK_REQUIRED",
      "Não foi possível confirmar a entrada. Tente novamente.",
    );
  }

  let binding: BackofficeBinding;
  try {
    binding = await openBackofficeBinding(auth);
  } catch (error) {
    await signOutBackofficeLocally(transient.auth);
    const parsed = databaseErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "42501") {
      throw new BackofficeApiError(
        403,
        "FORBIDDEN",
        "Esta conta não possui acesso ativo ao backoffice.",
      );
    }
    throw error;
  }

  const route = await createBackofficeRouteSupabaseClient();
  const cookieStore = await cookies();
  try {
    const priorAuth = await readAuthContext(route.client);
    if (priorAuth !== undefined) await closeBackofficeBinding(priorAuth);
    const publish = await route.client.auth.setSession({
      access_token: signIn.data.session.access_token,
      refresh_token: signIn.data.session.refresh_token,
    });
    if (publish.error !== null) throw publish.error;
  } catch {
    try {
      await closeBackofficeBinding(auth);
    } catch {
      // A binding expira de modo fail-closed mesmo se o fechamento imediato falhar.
    }
    await discardBackofficeSessionBestEffort({ auth: route.client.auth, cookieStore });
    await signOutBackofficeLocally(transient.auth);
    throw new BackofficeApiError(
      503,
      "AUTH_SESSION_RECHECK_REQUIRED",
      "Não foi possível confirmar a entrada. Tente novamente.",
    );
  }

  return { data: authenticatedSession(auth, binding), responseHeaders: route.responseHeaders };
}

export async function logoutBackoffice(expectedScope: string) {
  const route = await createBackofficeRouteSupabaseClient();
  const state = await readBoundSession(route.client);
  const cookieStore = await cookies();
  if (state === undefined) {
    clearBackofficeAuthCookies(cookieStore);
    return { data: { signedOut: true as const }, responseHeaders: route.responseHeaders };
  }
  if (state.auth.userId !== expectedScope) {
    throw new BackofficeApiError(
      409,
      "SESSION_CHANGED",
      "A sessão mudou. Recarregue antes de encerrar.",
    );
  }

  let bindingClosed = false;
  try {
    bindingClosed = await closeBackofficeBinding(state.auth);
  } catch {
    // O logout do provedor ainda pode invalidar o acesso mesmo sem confirmação do banco.
  }
  try {
    await signOutBackofficeLocally(route.client.auth);
    clearBackofficeAuthCookies(cookieStore);
  } catch (providerError) {
    if (!bindingClosed) throw providerError;
    clearBackofficeAuthCookies(cookieStore);
  }
  return { data: { signedOut: true as const }, responseHeaders: route.responseHeaders };
}
