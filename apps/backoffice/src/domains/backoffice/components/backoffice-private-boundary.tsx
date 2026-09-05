"use client";

import type { BackofficeSession } from "@set-livre/contracts";
import { createContext, useContext, type ReactNode } from "react";

import { BackofficeClientError, isAmbiguousBackofficeError } from "./backoffice-api";

const maximumBrowserTimeoutMs = 2_147_483_647;
const BackofficePrivateBoundaryContext = createContext<(() => void) | undefined>(undefined);

type PrivateBoundaryActions = Readonly<{
  clearPrivateState: () => void;
  hidePrivateView: () => void;
  notifySessionChanged: () => void;
  reloadAuthoritativeSession: () => void;
}>;

export function backofficeSessionExpirationDelay(expiresAt: string, now = Date.now()) {
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration)) return 0;
  return Math.max(0, Math.min(expiration - now, maximumBrowserTimeoutMs));
}

export function isBackofficeSessionDeadlineCurrent(
  currentSession: BackofficeSession | undefined,
  expectedSession: Extract<BackofficeSession, { authenticated: true }>,
  expectedExpiresAt: string,
) {
  return (
    currentSession?.authenticated === true &&
    currentSession.scope === expectedSession.scope &&
    currentSession.email === expectedSession.email &&
    currentSession.authorizationVersion === expectedSession.authorizationVersion &&
    currentSession.expiresAt === expectedExpiresAt
  );
}

export async function verifyBackofficeSessionDeadline(
  expectedSession: Extract<BackofficeSession, { authenticated: true }>,
  readSession: () => Promise<BackofficeSession | undefined>,
  activityGeneration: () => number,
) {
  for (;;) {
    // Um refetch cancelado pode resolver com o cache anterior. Só a geração
    // posterior à última atividade pode decidir se o prazo realmente venceu.
    const generation = activityGeneration();
    let session: BackofficeSession | undefined;
    try {
      session = await readSession();
    } catch {
      if (generation !== activityGeneration()) continue;
      return false;
    }
    if (generation !== activityGeneration()) continue;
    return (
      session?.authenticated === true &&
      isBackofficeSessionDeadlineCurrent(session, expectedSession, session.expiresAt) &&
      backofficeSessionExpirationDelay(session.expiresAt) > 0
    );
  }
}

export function isBackofficeReauthenticationBoundaryError(error: unknown) {
  return (
    (error instanceof BackofficeClientError && error.code === "AUTH_SESSION_RECHECK_REQUIRED") ||
    isAmbiguousBackofficeError(error)
  );
}

export function recomposeBackofficePrivateBoundary(actions: PrivateBoundaryActions) {
  try {
    actions.hidePrivateView();
  } finally {
    try {
      actions.clearPrivateState();
    } finally {
      try {
        actions.notifySessionChanged();
      } finally {
        actions.reloadAuthoritativeSession();
      }
    }
  }
}

export function BackofficePrivateBoundaryProvider({
  children,
  recompose,
}: Readonly<{ children: ReactNode; recompose: () => void }>) {
  return (
    <BackofficePrivateBoundaryContext.Provider value={recompose}>
      {children}
    </BackofficePrivateBoundaryContext.Provider>
  );
}

export function useBackofficePrivateBoundary() {
  const recompose = useContext(BackofficePrivateBoundaryContext);
  if (recompose === undefined) {
    throw new Error("A ação privada do backoffice precisa estar dentro da shell autenticada.");
  }
  return recompose;
}
