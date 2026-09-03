"use client";

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
