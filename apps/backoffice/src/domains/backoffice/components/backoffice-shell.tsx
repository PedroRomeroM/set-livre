"use client";

import type { BackofficeSession } from "@set-livre/contracts";
import { Alert, Button, Field } from "@set-livre/ui";
import { PasswordInput } from "@set-livre/ui/password-input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import {
  BackofficeClientError,
  logoutBackofficeClient,
  readBackofficeSessionClient,
  unlockBackofficeRuntimeClient,
} from "./backoffice-api";
import {
  backofficeSessionExpirationDelay,
  BackofficePrivateBoundaryProvider,
  isBackofficeReauthenticationBoundaryError,
  isBackofficeSessionDeadlineCurrent,
  recomposeBackofficePrivateBoundary,
} from "./backoffice-private-boundary";
import styles from "./backoffice.module.css";
import { backofficeQueryKeys } from "./query-keys";
import {
  notifyBackofficeSessionChanged,
  subscribeToBackofficeSessionChanges,
} from "./session-events";
import { useBackofficeHydrated } from "./use-backoffice-hydrated";

type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;
function runtimeUnlockErrorMessage(error: unknown) {
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível confirmar o desbloqueio. Tente novamente.";
}

export function BackofficeShell({
  children,
  navigation,
  session,
}: Readonly<{
  children: ReactNode;
  navigation: ReactNode;
  session: AuthenticatedSession;
}>) {
  const isHydrated = useBackofficeHydrated();
  const router = useRouter();
  const queryClient = useQueryClient();
  const intentionalLogout = useRef(false);
  const sessionRecompositionInProgress = useRef(false);
  const [logoutTransitionStarted, setLogoutTransitionStarted] = useState(false);
  const [sessionRecompositionStarted, setSessionRecompositionStarted] = useState(false);
  const pendingRuntimeKey = useRef<string>(undefined);
  const unlockForm = useRef<HTMLFormElement>(null);
  const currentSession = useQuery({
    initialData: session,
    initialDataUpdatedAt: 0,
    queryFn: readBackofficeSessionClient,
    queryKey: backofficeQueryKeys.session(session.scope),
    refetchInterval: 15_000,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 0,
  });
  const {
    data: currentSessionData,
    isError: currentSessionFailed,
    refetch: revalidateSession,
  } = currentSession;
  const sessionStillMatches =
    currentSessionData?.authenticated === true &&
    currentSessionData.scope === session.scope &&
    currentSessionData.email === session.email &&
    currentSessionData.authorizationVersion === session.authorizationVersion;
  const authoritativeExpiresAt =
    sessionStillMatches && currentSessionData?.authenticated === true
      ? currentSessionData.expiresAt
      : undefined;
  const sessionValidationExpired =
    authoritativeExpiresAt !== undefined &&
    backofficeSessionExpirationDelay(authoritativeExpiresAt) === 0;
  const privateViewUnsafe =
    currentSessionFailed || !sessionStillMatches || sessionValidationExpired;

  const navigateToAuthoritativeSession = useCallback(
    (destination: "/" | "/entrar") => {
      router.replace(destination);
      router.refresh();
    },
    [router],
  );

  const recomposeSession = useCallback(
    (notifyPeers = true) => {
      if (sessionRecompositionInProgress.current) return;
      sessionRecompositionInProgress.current = true;
      recomposeBackofficePrivateBoundary({
        clearPrivateState: () => queryClient.clear(),
        hidePrivateView: () => {
          flushSync(() => {
            setSessionRecompositionStarted(true);
          });
        },
        notifySessionChanged: () => {
          if (notifyPeers) notifyBackofficeSessionChanged();
        },
        reloadAuthoritativeSession: () => navigateToAuthoritativeSession("/"),
      });
    },
    [navigateToAuthoritativeSession, queryClient],
  );

  useEffect(() => {
    if (authoritativeExpiresAt === undefined) return;
    const delay = backofficeSessionExpirationDelay(authoritativeExpiresAt);
    if (delay === 0) return;
    const expiration = window.setTimeout(() => {
      const cachedSession = queryClient.getQueryData<BackofficeSession>(
        backofficeQueryKeys.session(session.scope),
      );
      if (!isBackofficeSessionDeadlineCurrent(cachedSession, session, authoritativeExpiresAt))
        return;
      recomposeSession();
    }, delay);
    return () => window.clearTimeout(expiration);
  }, [authoritativeExpiresAt, queryClient, recomposeSession, session]);

  useEffect(
    () =>
      subscribeToBackofficeSessionChanges(() => {
        if (intentionalLogout.current) return;
        recomposeSession(false);
      }),
    [recomposeSession],
  );

  useEffect(() => {
    if (!currentSessionFailed && sessionStillMatches && !sessionValidationExpired) return;
    if (intentionalLogout.current) return;
    queryClient.clear();
    navigateToAuthoritativeSession(currentSessionData?.authenticated === true ? "/" : "/entrar");
  }, [
    currentSessionData?.authenticated,
    currentSessionFailed,
    navigateToAuthoritativeSession,
    queryClient,
    sessionValidationExpired,
    sessionStillMatches,
  ]);

  const logout = useMutation({
    mutationFn: () => logoutBackofficeClient(session.scope),
    onError: (error) => {
      if (!isBackofficeReauthenticationBoundaryError(error)) return;
      recomposeSession();
    },
    onSuccess: () => {
      intentionalLogout.current = true;
      flushSync(() => {
        setLogoutTransitionStarted(true);
      });
      queryClient.clear();
      notifyBackofficeSessionChanged();
      router.replace("/entrar?saida=sucesso");
      router.refresh();
    },
  });
  const unlock = useMutation({
    mutationFn: () => {
      if (pendingRuntimeKey.current === undefined) {
        throw new Error("O desbloqueio não possui uma chave efêmera preparada.");
      }
      return unlockBackofficeRuntimeClient({ key: pendingRuntimeKey.current });
    },
    networkMode: "always",
    onSettled: () => {
      pendingRuntimeKey.current = undefined;
      unlockForm.current?.reset();
    },
    onSuccess: () => {
      void revalidateSession();
    },
  });
  const runtimeUnlockExpiresAt =
    currentSessionData?.authenticated === true
      ? currentSessionData.runtimeUnlockExpiresAt
      : session.runtimeUnlockExpiresAt;
  const runtimeControlsDisabled =
    !isHydrated || !currentSession.isFetchedAfterMount || unlock.isPending;

  if (logoutTransitionStarted || sessionRecompositionStarted || privateViewUnsafe) {
    return (
      <main className={styles.main} id="conteudo-principal">
        <p role="status">Encerrando a visualização privada…</p>
      </main>
    );
  }

  return (
    <div className={styles.shell}>
      <nav aria-label="Atalhos de acessibilidade">
        <a className={styles.skipLink} href="#conteudo-principal">
          Ir para o conteúdo
        </a>
      </nav>
      <header className={styles.header}>
        <div>
          <p className={styles.brand}>Set Livre</p>
          <p className={styles.environment}>Backoffice operacional</p>
        </div>
        <div className={styles.sessionSummary}>
          <span>{session.email}</span>
          <Button
            disabled={!isHydrated}
            loading={logout.isPending}
            loadingLabel="Saindo"
            onClick={() => logout.mutate()}
            variant="ghost"
          >
            Sair
          </Button>
        </div>
      </header>
      {navigation}
      {isHydrated ? null : (
        <p className={styles.runtimeUnlockPreparation} role="status">
          Preparando o desbloqueio seguro…
        </p>
      )}
      <noscript>
        <p className={styles.globalError} role="alert">
          Habilite o JavaScript e recarregue a página para desbloquear operações críticas.
        </p>
      </noscript>
      <form
        aria-label="Desbloqueio de operações críticas"
        aria-busy={runtimeControlsDisabled}
        className={styles.runtimeUnlock}
        inert={!isHydrated}
        method="post"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          pendingRuntimeKey.current = String(data.get("runtimeUnlockKey") ?? "");
          unlock.mutate();
        }}
        ref={unlockForm}
      >
        <fieldset className={styles.runtimeUnlockBoundary} disabled={!isHydrated}>
          <Field
            description="A chave não é armazenada no navegador. O desbloqueio expira em cinco minutos."
            label="Chave local de desbloqueio"
            required
          >
            <PasswordInput
              autoComplete="off"
              disabled={runtimeControlsDisabled}
              maxLength={43}
              name="runtimeUnlockKey"
            />
          </Field>
          <Button
            disabled={runtimeControlsDisabled}
            loading={unlock.isPending}
            loadingLabel="Desbloqueando"
            type="submit"
          >
            Desbloquear operações
          </Button>
          {runtimeUnlockExpiresAt === null ? (
            <p className={styles.muted}>Operações críticas bloqueadas neste runtime.</p>
          ) : (
            <p role="status">
              Operações desbloqueadas até{" "}
              {new Date(runtimeUnlockExpiresAt).toLocaleTimeString("pt-BR", {
                timeZone: "America/Sao_Paulo",
              })}
              .
            </p>
          )}
          {unlock.isError ? (
            <Alert variant="error">{runtimeUnlockErrorMessage(unlock.error)}</Alert>
          ) : null}
        </fieldset>
      </form>
      {logout.isError ? (
        <p className={styles.globalError} role="alert">
          Não foi possível encerrar a sessão. Tente novamente.
        </p>
      ) : null}
      <main className={styles.main} id="conteudo-principal">
        <BackofficePrivateBoundaryProvider recompose={recomposeSession}>
          {children}
        </BackofficePrivateBoundaryProvider>
      </main>
    </div>
  );
}
