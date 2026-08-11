import "server-only";

import {
  identityLoginResultSchema,
  identityRecoveryRequestResultSchema,
  identityRecoveryStatusResultSchema,
  identityRecoveryUpdateResultSchema,
  identityRegisterResultSchema,
  resolveAuthenticatedReturnTo,
  type IdentityLoginPayload,
  type IdentityRegistrationPayload,
  type IdentitySession,
} from "@set-livre/contracts";
import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";

import { ApiRouteError, hashPrivateRateLimitValue } from "@/lib/server/api-route";
import { enforceIdentityRateLimit } from "@/lib/server/rate-limit";
import { readSupabaseEnvironment } from "@/lib/supabase/config";
import { createAnonymousSupabaseClient, createRouteSupabaseClient } from "@/lib/supabase/server";

import {
  claimIdentityRecoveryGrant,
  consumeIdentityRecoveryGrant,
  createSignupLegalIntent,
  hasIdentityRecoveryGrant,
  issueIdentityRecoveryGrant,
  releaseIdentityRecoveryGrant,
} from "./identity-dal";
import {
  handleCallbackProviderError,
  handleLoginProviderError,
  handleLogoutProviderError,
  handlePasswordUpdateProviderError,
  handleRecoveryRequestProviderError,
  handleRegistrationProviderError,
  isPasswordUpdateProviderErrorSafeToRetry,
} from "./identity-provider-errors";
import { readIdentitySessionWithClient } from "./identity-read-model";
import { recoveryGrantCookieName, recoveryGrantMaximumAgeSeconds } from "./recovery-grant";

const databaseErrorSchema = z.object({ code: z.string().optional() });
const claimsSchema = z.object({ sub: z.uuid() });
type IdentityCookieStore = Awaited<ReturnType<typeof cookies>>;
type IdentitySupabaseAuth = ReturnType<typeof createAnonymousSupabaseClient>["auth"];

function userAgentEvidence(userAgent: string | null) {
  return userAgent === null ? null : createHash("sha256").update(userAgent).digest("hex");
}

function clearSupabaseAuthCookies(cookieStore: IdentityCookieStore, supabaseOrigin: string) {
  let projectReference: string | undefined;
  try {
    projectReference = new URL(supabaseOrigin).hostname.split(".")[0];
  } catch {
    return;
  }
  if (projectReference === undefined || projectReference === "") {
    return;
  }
  const storageKey = `sb-${projectReference}-auth-token`;
  let currentCookies: ReturnType<IdentityCookieStore["getAll"]>;
  try {
    currentCookies = cookieStore.getAll();
  } catch {
    return;
  }
  for (const cookie of currentCookies) {
    const chunk = cookie.name.startsWith(`${storageKey}.`)
      ? cookie.name.slice(storageKey.length + 1)
      : undefined;
    if (cookie.name === storageKey || (chunk !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(chunk))) {
      try {
        cookieStore.delete(cookie.name);
      } catch {
        // Uma falha pontual não impede a tentativa de apagar os demais chunks.
      }
    }
  }
}

function deleteCookieBestEffort(cookieStore: IdentityCookieStore, name: string) {
  try {
    cookieStore.delete(name);
  } catch {
    // A limpeza das demais credenciais conhecidas ainda precisa continuar.
  }
}

async function signOutLocalOrProveAbsent(auth: IdentitySupabaseAuth) {
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

async function signOutLocalAndClearExactAuthCookies(input: {
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

async function discardIdentitySessionBestEffort(input: {
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

function isProvenCallbackRejection(error: unknown, type: "recovery" | "signup") {
  return (
    error instanceof ApiRouteError &&
    (error.code === "RATE_LIMITED" ||
      (type === "recovery" && error.code === "RECOVERY_INVALID") ||
      (type === "signup" && error.code === "AUTH_INVALID"))
  );
}

async function restartAfterAmbiguousCallback(input: {
  auth: IdentitySupabaseAuth;
  cookieStore: IdentityCookieStore;
  recoveryGrant?: string | undefined;
  supabaseOrigin: string;
  type: "recovery" | "signup";
  userId?: string | undefined;
}): Promise<never> {
  if (input.type === "recovery") {
    deleteCookieBestEffort(input.cookieStore, recoveryGrantCookieName);
  }
  if (input.recoveryGrant !== undefined && input.userId !== undefined) {
    try {
      const attemptId = randomUUID();
      if (
        await claimIdentityRecoveryGrant({
          attemptId,
          token: input.recoveryGrant,
          userId: input.userId,
        })
      ) {
        await consumeIdentityRecoveryGrant({
          attemptId,
          token: input.recoveryGrant,
          userId: input.userId,
        });
      }
    } catch {
      // O grant permanece claimed/expirável e não pode autorizar outra tentativa.
    }
  }
  await discardIdentitySessionBestEffort(input);
  throw new ApiRouteError(
    503,
    input.type === "recovery" ? "RECOVERY_RESTART_REQUIRED" : "AUTH_RESTART_REQUIRED",
    input.type === "recovery"
      ? "Não foi possível preparar a recuperação agora. Solicite um novo link."
      : "Não foi possível confirmar o cadastro com segurança. Solicite um novo link de confirmação.",
  );
}

export async function registerIdentity(
  payload: IdentityRegistrationPayload,
  context: Readonly<{ requestId: string; userAgent: string | null }>,
) {
  const emailDiscriminator = hashPrivateRateLimitValue(payload.email);
  enforceIdentityRateLimit("identity.register", emailDiscriminator, {
    limit: 5,
    windowMs: 60 * 60_000,
  });

  let legalIntent: string;
  try {
    legalIntent = await createSignupLegalIntent({
      evidence: { ipHash: null, userAgentHash: userAgentEvidence(context.userAgent) },
      personType: payload.personType,
      privacyVersionId: payload.privacyVersionId,
      requestId: context.requestId,
      termsVersionId: payload.termsVersionId,
    });
  } catch (error) {
    const parsed = databaseErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "23514") {
      throw new ApiRouteError(
        409,
        "CONFLICT",
        "Os documentos legais foram atualizados. Recarregue a página e revise as versões vigentes.",
      );
    }
    throw error;
  }

  const environment = readSupabaseEnvironment();
  const client = createAnonymousSupabaseClient();
  const { error } = await client.auth.signUp({
    email: payload.email,
    options: {
      data: { sl_legal_intent: legalIntent },
      emailRedirectTo: `${environment.appOrigin}/auth/callback`,
    },
    password: payload.password,
  });
  if (error !== null) {
    handleRegistrationProviderError(error);
  }
  return identityRegisterResultSchema.parse({ confirmationRequired: true });
}

export async function loginIdentity(payload: IdentityLoginPayload) {
  const emailDiscriminator = hashPrivateRateLimitValue(payload.email);
  enforceIdentityRateLimit("identity.login", emailDiscriminator, {
    limit: 10,
    windowMs: 15 * 60_000,
  });
  const transientClient = createAnonymousSupabaseClient();
  const { data, error } = await transientClient.auth.signInWithPassword({
    email: payload.email,
    password: payload.password,
  });
  if (error !== null) {
    handleLoginProviderError(error);
  }
  let session: IdentitySession;
  try {
    if (data.session === null || data.user === null) {
      throw new ApiRouteError(503, "SERVICE_UNAVAILABLE", "Não foi possível validar a sessão.");
    }
    session = await readIdentitySessionWithClient(transientClient);
    if (!session.authenticated) {
      throw new ApiRouteError(401, "AUTH_INVALID", "Não foi possível validar a sessão.");
    }
  } catch (sessionError) {
    try {
      await transientClient.auth.signOut({ scope: "local" });
    } catch {
      // Nenhum cookie foi publicado; a falha original permanece redigida e autoritativa.
    }
    throw sessionError;
  }

  const route = await createRouteSupabaseClient();
  const cookieStore = await cookies();
  const supabaseOrigin = readSupabaseEnvironment().supabaseOrigin;
  let publishError: unknown = null;
  try {
    const publishResult = await route.client.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    publishError = publishResult.error;
  } catch (sessionError) {
    publishError = sessionError;
  }
  if (publishError !== null) {
    await discardIdentitySessionBestEffort({
      auth: route.client.auth,
      cookieStore,
      supabaseOrigin,
    });
    try {
      await transientClient.auth.signOut({ scope: "local" });
    } catch {
      // A sessão nunca foi aceita como publicada; o erro público permanece genérico.
    }
    handleLoginProviderError(publishError);
  }
  return {
    data: identityLoginResultSchema.parse({
      redirectTo: resolveAuthenticatedReturnTo(payload.returnTo),
      session,
    }),
    responseHeaders: route.responseHeaders,
  };
}

export async function logoutIdentity() {
  const route = await createRouteSupabaseClient();
  await signOutLocalOrProveAbsent(route.client.auth);
  return { data: { signedOut: true as const }, responseHeaders: route.responseHeaders };
}

export async function requestIdentityRecovery(email: string) {
  const discriminator = hashPrivateRateLimitValue(email);
  enforceIdentityRateLimit("identity.recovery.request", discriminator, {
    limit: 5,
    windowMs: 60 * 60_000,
  });
  const environment = readSupabaseEnvironment();
  const client = createAnonymousSupabaseClient();
  let providerError: unknown = null;
  try {
    const result = await client.auth.resetPasswordForEmail(email, {
      redirectTo: `${environment.appOrigin}/auth/callback`,
    });
    providerError = result.error;
  } catch (error) {
    providerError = error;
  }
  if (providerError !== null) {
    return {
      data: identityRecoveryRequestResultSchema.parse({ accepted: true }),
      operationalOutcome: handleRecoveryRequestProviderError(providerError),
    };
  }
  return {
    data: identityRecoveryRequestResultSchema.parse({ accepted: true }),
    operationalOutcome: "accepted" as const,
  };
}

export async function verifyIdentityCallback(input: {
  returnTo?: string | undefined;
  tokenHash: string;
  type: "recovery" | "signup";
}) {
  enforceIdentityRateLimit("identity.callback", hashPrivateRateLimitValue(input.tokenHash), {
    limit: 10,
    windowMs: 10 * 60_000,
  });
  const route = await createRouteSupabaseClient();
  const callbackContext = {
    cookieStore: await cookies(),
    supabaseOrigin: readSupabaseEnvironment().supabaseOrigin,
  };
  let recoveryGrant: string | undefined;
  let verifiedUserId: string | undefined;
  try {
    const verification = await route.client.auth.verifyOtp({
      token_hash: input.tokenHash,
      type: input.type,
    });
    if (verification.error !== null) {
      handleCallbackProviderError(verification.error, input.type);
    }
    if (verification.data.user === null || verification.data.session === null) {
      throw new ApiRouteError(503, "SERVICE_UNAVAILABLE", "Não foi possível validar o link agora.");
    }
    verifiedUserId = verification.data.user.id;

    if (input.type === "recovery") {
      recoveryGrant = await issueIdentityRecoveryGrant(verifiedUserId);
      callbackContext.cookieStore.set(recoveryGrantCookieName, recoveryGrant, {
        ...readSupabaseEnvironment().cookieOptions,
        maxAge: recoveryGrantMaximumAgeSeconds,
        sameSite: "strict",
      });
    }

    const redirectTo =
      input.type === "recovery"
        ? "/recuperar-senha?modo=nova-senha"
        : input.returnTo === undefined
          ? "/entrar?confirmacao=sucesso"
          : resolveAuthenticatedReturnTo(input.returnTo);
    return { data: { redirectTo }, responseHeaders: route.responseHeaders };
  } catch (error) {
    if (isProvenCallbackRejection(error, input.type)) {
      throw error;
    }
    return restartAfterAmbiguousCallback({
      auth: route.client.auth,
      cookieStore: callbackContext.cookieStore,
      recoveryGrant,
      supabaseOrigin: callbackContext.supabaseOrigin,
      type: input.type,
      userId: verifiedUserId,
    });
  }
}

async function recoveryIdentity() {
  const route = await createRouteSupabaseClient();
  const claimsResult = await route.client.auth.getClaims();
  const claims = claimsSchema.safeParse(claimsResult.data?.claims);
  const cookieStore = await cookies();
  const token = cookieStore.get(recoveryGrantCookieName)?.value;
  const supabaseOrigin = readSupabaseEnvironment().supabaseOrigin;
  return { claims, cookieStore, route, supabaseOrigin, token };
}

async function discardRecoverySessionBestEffort(
  state: Awaited<ReturnType<typeof recoveryIdentity>>,
) {
  deleteCookieBestEffort(state.cookieStore, recoveryGrantCookieName);
  await discardIdentitySessionBestEffort({
    auth: state.route.client.auth,
    cookieStore: state.cookieStore,
    supabaseOrigin: state.supabaseOrigin,
  });
}

export async function readIdentityRecoveryStatus() {
  const state = await recoveryIdentity();
  const parsedToken = z.uuid().safeParse(state.token);
  const allowed =
    state.claims.success &&
    parsedToken.success &&
    (await hasIdentityRecoveryGrant({
      token: parsedToken.data,
      userId: state.claims.data.sub,
    }));
  return {
    data: identityRecoveryStatusResultSchema.parse({ allowed }),
    responseHeaders: state.route.responseHeaders,
  };
}

export async function updateRecoveredIdentityPassword(password: string) {
  const state = await recoveryIdentity();
  const parsedToken = z.uuid().safeParse(state.token);
  if (!state.claims.success || !parsedToken.success) {
    throw new ApiRouteError(
      403,
      "RECOVERY_INVALID",
      "Este link é inválido ou expirou. Solicite um novo link.",
    );
  }
  enforceIdentityRateLimit("identity.recovery.update", state.claims.data.sub, {
    limit: 5,
    windowMs: 60 * 60_000,
  });
  const attemptId = randomUUID();
  const grantInput = {
    attemptId,
    token: parsedToken.data,
    userId: state.claims.data.sub,
  };
  if (!(await claimIdentityRecoveryGrant(grantInput))) {
    throw new ApiRouteError(
      403,
      "RECOVERY_INVALID",
      "Este link é inválido ou expirou. Solicite um novo link.",
    );
  }

  let providerError: unknown = null;
  try {
    const result = await state.route.client.auth.updateUser({ password });
    providerError = result.error;
  } catch (error) {
    providerError = error;
  }
  if (providerError !== null) {
    if (isPasswordUpdateProviderErrorSafeToRetry(providerError)) {
      let released = false;
      try {
        released = await releaseIdentityRecoveryGrant(grantInput);
      } catch {
        // Falha fechada: sem release comprovado, a tentativa não pode ser repetida.
      }
      if (!released) {
        await discardRecoverySessionBestEffort(state);
        throw new ApiRouteError(
          503,
          "SERVICE_UNAVAILABLE",
          "Não foi possível concluir a recuperação agora. Solicite um novo link.",
        );
      }
    } else {
      await discardRecoverySessionBestEffort(state);
    }
    handlePasswordUpdateProviderError(providerError);
  }

  let consumed = false;
  try {
    consumed = await consumeIdentityRecoveryGrant(grantInput);
  } catch {
    // A falha pública não expõe o banco e a claim impede outro consumo.
  }
  if (!consumed) {
    await discardRecoverySessionBestEffort(state);
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "A senha foi atualizada, mas a recuperação não pôde ser finalizada. Entre novamente.",
    );
  }
  deleteCookieBestEffort(state.cookieStore, recoveryGrantCookieName);
  await signOutLocalAndClearExactAuthCookies({
    auth: state.route.client.auth,
    cookieStore: state.cookieStore,
    supabaseOrigin: state.supabaseOrigin,
  });
  return {
    data: identityRecoveryUpdateResultSchema.parse({ updated: true }),
    responseHeaders: state.route.responseHeaders,
  };
}
