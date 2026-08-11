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
  claimIdentityRecoveryContext,
  closeIdentityRecoverySession,
  consumeIdentityRecoveryContext,
  createSignupLegalIntent,
  inspectIdentityRecoverySession,
  issueIdentityRecoveryContext,
  releaseIdentityRecoveryContext,
} from "./identity-dal";
import {
  deleteCookieBestEffort,
  discardIdentitySessionBestEffort,
  parseAuthSessionContext,
  signOutLocalAndClearExactAuthCookies,
  signOutLocalOrProveAbsent,
  type IdentityCookieStore,
  type IdentitySupabaseAuth,
} from "./identity-auth-session";
import {
  handleCallbackProviderError,
  handleLoginProviderError,
  handlePasswordUpdateProviderError,
  handleRecoveryRequestProviderError,
  handleRegistrationProviderError,
  isPasswordUpdateProviderErrorSafeToRetry,
} from "./identity-provider-errors";
import { readIdentitySessionWithClient } from "./identity-read-model";
import {
  recoveryGrantCookieName,
  recoveryGrantMaximumAgeSeconds,
  recoverySessionCookieMaximumAgeSeconds,
  recoverySessionCookieName,
  recoverySessionScopeFromCookieStore,
} from "./recovery-grant";

const databaseErrorSchema = z.object({ code: z.string().optional() });

function userAgentEvidence(userAgent: string | null) {
  return userAgent === null ? null : createHash("sha256").update(userAgent).digest("hex");
}

function isProvenCallbackRejection(error: unknown, type: "recovery" | "signup") {
  return (
    error instanceof ApiRouteError &&
    (error.code === "RATE_LIMITED" ||
      (type === "recovery" && error.code === "RECOVERY_INVALID") ||
      (type === "signup" && error.code === "AUTH_INVALID"))
  );
}

async function closeCurrentRecoveryBindingBestEffort(auth: IdentitySupabaseAuth) {
  try {
    const claimsResult = await auth.getClaims();
    if (claimsResult.error !== null) {
      return;
    }
    const context = parseAuthSessionContext(claimsResult.data?.claims);
    if (context === undefined) {
      return;
    }
    const binding = await inspectIdentityRecoverySession({
      authExpiresAt: context.authExpiresAt,
      authSessionId: context.authSessionId,
      sessionScope: null,
      token: null,
      userId: context.userId,
    });
    if (binding !== undefined) {
      await closeIdentityRecoverySession({
        authSessionId: context.authSessionId,
        userId: context.userId,
      });
    }
  } catch {
    // O tombstone continua detectável; as credenciais locais ainda serão substituídas/removidas.
  }
}

async function restartAfterAmbiguousCallback(input: {
  auth: IdentitySupabaseAuth;
  cookieStore: IdentityCookieStore;
  recoveryContext?:
    | Readonly<{
        authSessionId: string;
        sessionScope: string;
        token: string;
        userId: string;
      }>
    | undefined;
  supabaseOrigin: string;
  type: "recovery" | "signup";
}): Promise<never> {
  deleteCookieBestEffort(input.cookieStore, recoveryGrantCookieName);
  deleteCookieBestEffort(input.cookieStore, recoverySessionCookieName);
  if (input.recoveryContext !== undefined) {
    try {
      await closeIdentityRecoverySession({
        authSessionId: input.recoveryContext.authSessionId,
        userId: input.recoveryContext.userId,
      });
    } catch {
      // A binding permanece detectável e não pode virar uma sessão comum.
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
  await closeCurrentRecoveryBindingBestEffort(route.client.auth);
  deleteCookieBestEffort(cookieStore, recoveryGrantCookieName);
  deleteCookieBestEffort(cookieStore, recoverySessionCookieName);
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
  const cookieStore = await cookies();
  await closeCurrentRecoveryBindingBestEffort(route.client.auth);
  deleteCookieBestEffort(cookieStore, recoveryGrantCookieName);
  deleteCookieBestEffort(cookieStore, recoverySessionCookieName);
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
  let recoveryContext:
    | Readonly<{
        authSessionId: string;
        sessionScope: string;
        token: string;
        userId: string;
      }>
    | undefined;
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
    const claimsResult = await route.client.auth.getClaims(verification.data.session.access_token);
    const authContext =
      claimsResult.error === null ? parseAuthSessionContext(claimsResult.data?.claims) : undefined;
    if (
      authContext === undefined ||
      authContext.userId !== verification.data.user.id ||
      authContext.authExpiresAtEpochSeconds <= Math.floor(Date.now() / 1_000)
    ) {
      throw new ApiRouteError(503, "SERVICE_UNAVAILABLE", "Não foi possível validar o link agora.");
    }

    if (input.type === "recovery") {
      const issuedContext = await issueIdentityRecoveryContext({
        authExpiresAt: authContext.authExpiresAt,
        authSessionId: authContext.authSessionId,
        userId: authContext.userId,
      });
      recoveryContext = { ...authContext, ...issuedContext };
      callbackContext.cookieStore.set(recoveryGrantCookieName, issuedContext.token, {
        ...readSupabaseEnvironment().cookieOptions,
        maxAge: recoveryGrantMaximumAgeSeconds,
        sameSite: "strict",
      });
      callbackContext.cookieStore.set(recoverySessionCookieName, issuedContext.sessionScope, {
        ...readSupabaseEnvironment().cookieOptions,
        maxAge: recoverySessionCookieMaximumAgeSeconds(authContext.authExpiresAtEpochSeconds),
        sameSite: "strict",
      });
    } else {
      deleteCookieBestEffort(callbackContext.cookieStore, recoveryGrantCookieName);
      deleteCookieBestEffort(callbackContext.cookieStore, recoverySessionCookieName);
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
      recoveryContext,
      supabaseOrigin: callbackContext.supabaseOrigin,
      type: input.type,
    });
  }
}

async function recoveryIdentity() {
  const route = await createRouteSupabaseClient();
  const claimsResult = await route.client.auth.getClaims();
  const authContext =
    claimsResult.error === null ? parseAuthSessionContext(claimsResult.data?.claims) : undefined;
  const cookieStore = await cookies();
  const parsedToken = z.uuid().safeParse(cookieStore.get(recoveryGrantCookieName)?.value);
  const token = parsedToken.success ? parsedToken.data : null;
  const cookieScope = recoverySessionScopeFromCookieStore(cookieStore);
  const sessionScope = cookieScope === "anonymous" ? null : cookieScope;
  const supabaseOrigin = readSupabaseEnvironment().supabaseOrigin;
  let binding: Awaited<ReturnType<typeof inspectIdentityRecoverySession>>;
  try {
    binding =
      authContext === undefined
        ? undefined
        : await inspectIdentityRecoverySession({
            authExpiresAt: authContext.authExpiresAt,
            authSessionId: authContext.authSessionId,
            sessionScope,
            token,
            userId: authContext.userId,
          });
  } catch (error) {
    deleteCookieBestEffort(cookieStore, recoveryGrantCookieName);
    deleteCookieBestEffort(cookieStore, recoverySessionCookieName);
    throw error;
  }
  return {
    authContext,
    binding,
    cookieStore,
    route,
    sessionScope,
    supabaseOrigin,
    token,
  };
}

function clearRecoveryCookies(state: Awaited<ReturnType<typeof recoveryIdentity>>) {
  deleteCookieBestEffort(state.cookieStore, recoveryGrantCookieName);
  deleteCookieBestEffort(state.cookieStore, recoverySessionCookieName);
}

async function closeAndDiscardRecoverySession(state: Awaited<ReturnType<typeof recoveryIdentity>>) {
  if (state.authContext !== undefined && state.binding !== undefined) {
    try {
      await closeIdentityRecoverySession({
        authSessionId: state.authContext.authSessionId,
        userId: state.authContext.userId,
      });
    } catch {
      // O tombstone ativo continua classificando a sessão como recovery.
    }
  }
  clearRecoveryCookies(state);
  await signOutLocalAndClearExactAuthCookies({
    auth: state.route.client.auth,
    cookieStore: state.cookieStore,
    supabaseOrigin: state.supabaseOrigin,
  });
}

async function discardRecoverySessionBestEffort(
  state: Awaited<ReturnType<typeof recoveryIdentity>>,
) {
  try {
    await closeAndDiscardRecoverySession(state);
  } catch {
    // O erro causal do fluxo permanece autoritativo e redigido.
  }
}

export async function readIdentityRecoveryStatus() {
  const state = await recoveryIdentity();
  if (state.authContext === undefined || state.binding === undefined) {
    clearRecoveryCookies(state);
    return {
      data: identityRecoveryStatusResultSchema.parse({
        allowed: false,
        scope: "anonymous",
      }),
      responseHeaders: state.route.responseHeaders,
    };
  }
  const allowed =
    state.binding.active &&
    state.binding.grantAllowed &&
    state.sessionScope === state.binding.sessionScope;
  if (!allowed) {
    await closeAndDiscardRecoverySession(state);
  }
  return {
    data: identityRecoveryStatusResultSchema.parse({
      allowed,
      scope: allowed ? state.binding.sessionScope : "anonymous",
    }),
    responseHeaders: state.route.responseHeaders,
  };
}

export async function updateRecoveredIdentityPassword(password: string) {
  const state = await recoveryIdentity();
  if (state.authContext === undefined || state.binding === undefined) {
    clearRecoveryCookies(state);
    throw new ApiRouteError(
      403,
      "RECOVERY_INVALID",
      "Este link é inválido ou expirou. Solicite um novo link.",
    );
  }
  if (
    !state.binding.active ||
    !state.binding.grantAllowed ||
    state.token === null ||
    state.sessionScope !== state.binding.sessionScope
  ) {
    await closeAndDiscardRecoverySession(state);
    throw new ApiRouteError(
      403,
      "RECOVERY_INVALID",
      "Este link é inválido ou expirou. Solicite um novo link.",
    );
  }
  enforceIdentityRateLimit("identity.recovery.update", state.authContext.userId, {
    limit: 5,
    windowMs: 60 * 60_000,
  });
  const attemptId = randomUUID();
  const grantInput = {
    attemptId,
    authSessionId: state.authContext.authSessionId,
    sessionScope: state.binding.sessionScope,
    token: state.token,
    userId: state.authContext.userId,
  };
  if (!(await claimIdentityRecoveryContext(grantInput))) {
    await closeAndDiscardRecoverySession(state);
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
        released = await releaseIdentityRecoveryContext(grantInput);
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
    consumed = await consumeIdentityRecoveryContext(grantInput);
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
  await closeAndDiscardRecoverySession(state);
  return {
    data: identityRecoveryUpdateResultSchema.parse({ updated: true }),
    responseHeaders: state.route.responseHeaders,
  };
}
