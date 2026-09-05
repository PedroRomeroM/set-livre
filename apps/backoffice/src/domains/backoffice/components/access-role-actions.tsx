"use client";

import type {
  BackofficeAccessCommand,
  BackofficeSession,
  BackofficeUserSummary,
} from "@set-livre/contracts";
import { Alert, Button, Field } from "@set-livre/ui";
import { PasswordInput } from "@set-livre/ui/password-input";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  BackofficeClientError,
  executeBackofficeUserCommand,
  isAmbiguousBackofficeError,
  isStaleBackofficeError,
  loginBackofficeClient,
} from "./backoffice-api";
import {
  isBackofficeReauthenticationBoundaryError,
  useBackofficePrivateBoundary,
} from "./backoffice-private-boundary";
import styles from "./backoffice.module.css";
import { backofficeQueryKeys } from "./query-keys";
import { notifyBackofficePeerSessionsChanged } from "./session-events";
import { useBackofficeHydrated } from "./use-backoffice-hydrated";

type AccessAction = BackofficeAccessCommand["action"];
type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;
type BackofficeSessionCache = Pick<QueryClient, "getQueryData" | "setQueryData">;

function matchesBackofficeSessionBoundary(
  candidate: BackofficeSession | undefined,
  expected: AuthenticatedSession,
): candidate is AuthenticatedSession {
  return (
    candidate?.authenticated === true &&
    candidate.scope === expected.scope &&
    candidate.email === expected.email &&
    candidate.authorizationVersion === expected.authorizationVersion
  );
}

export function reconcileSuccessfulBackofficeReauthentication({
  currentSession,
  nextSession,
  notifyPeerSessionsChanged,
  queryClient,
  recomposeSession,
}: Readonly<{
  currentSession: AuthenticatedSession;
  nextSession: AuthenticatedSession;
  notifyPeerSessionsChanged: () => void;
  queryClient: BackofficeSessionCache;
  recomposeSession: () => void;
}>): "published" | "session-boundary" {
  const sessionKey = backofficeQueryKeys.session(currentSession.scope);
  const cachedSession = queryClient.getQueryData<BackofficeSession>(sessionKey);
  if (
    !matchesBackofficeSessionBoundary(cachedSession, currentSession) ||
    !matchesBackofficeSessionBoundary(nextSession, currentSession)
  ) {
    recomposeSession();
    return "session-boundary";
  }

  queryClient.setQueryData<BackofficeSession>(sessionKey, nextSession);
  notifyPeerSessionsChanged();
  return "published";
}

export type BackofficeAccessTransition = Readonly<{
  action: AccessAction;
  buttonLabel: string;
  confirmation: string;
}>;

type AccessRefreshExpectation = Readonly<{
  minimumAccountVersion: number;
  outcome: "applied" | "conflict";
  userId: string;
}>;

export function isBackofficeAccessRefreshVerified(
  expected: AccessRefreshExpectation,
  user: BackofficeUserSummary,
) {
  return user.id === expected.userId && user.accountVersion >= expected.minimumAccountVersion;
}

function errorMessage(error: unknown) {
  if (isAmbiguousBackofficeError(error)) {
    return "O resultado não pôde ser confirmado. Repita a mesma tentativa para consultar o resultado idempotente.";
  }
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível concluir agora. Tente novamente.";
}

function AccessReauthentication({
  onConfirmed,
  onSessionBoundary,
  session,
}: {
  onConfirmed: (session: AuthenticatedSession) => void;
  onSessionBoundary: () => void;
  session: AuthenticatedSession;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const pendingPassword = useRef<string>(undefined);
  const reauthenticate = useMutation({
    gcTime: 0,
    mutationFn: () => {
      if (pendingPassword.current === undefined) {
        throw new Error("A reautenticação não possui senha efêmera preparada.");
      }
      return loginBackofficeClient({ email: session.email, password: pendingPassword.current });
    },
    networkMode: "always",
    onSettled: () => {
      pendingPassword.current = undefined;
      formRef.current?.reset();
    },
    onError: (error) => {
      if (!isBackofficeReauthenticationBoundaryError(error)) return;
      pendingPassword.current = undefined;
      formRef.current?.reset();
      onSessionBoundary();
    },
    onSuccess: (nextSession) => {
      if (nextSession.authenticated) {
        onConfirmed(nextSession);
        return;
      }
      onSessionBoundary();
    },
  });
  return (
    <form
      className={styles.reauthentication}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        pendingPassword.current = String(data.get("password") ?? "");
        reauthenticate.mutate();
      }}
      ref={formRef}
    >
      <h2>Confirme sua identidade</h2>
      <p>Alterações de acesso exigem uma autenticação realizada nos últimos cinco minutos.</p>
      <Field label="Senha atual" required>
        <PasswordInput autoComplete="current-password" name="password" />
      </Field>
      {reauthenticate.isError ? (
        <Alert variant="error">{errorMessage(reauthenticate.error)}</Alert>
      ) : null}
      <Button loading={reauthenticate.isPending} loadingLabel="Confirmando" type="submit">
        Confirmar identidade
      </Button>
    </form>
  );
}

export function AccessRoleActions({
  children,
  session,
  transitions,
  user,
}: {
  children: ReactNode;
  session: AuthenticatedSession;
  transitions: readonly BackofficeAccessTransition[];
  user: BackofficeUserSummary;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const interactive = useBackofficeHydrated();
  const recomposeSession = useBackofficePrivateBoundary();
  const [selected, setSelected] = useState<BackofficeAccessTransition>();
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [refreshExpectation, setRefreshExpectation] = useState<AccessRefreshExpectation>();
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [refreshTimedOut, setRefreshTimedOut] = useState(false);
  const refreshPending =
    refreshExpectation !== undefined &&
    !isBackofficeAccessRefreshVerified(refreshExpectation, user);
  const verifiedNotice =
    refreshExpectation === undefined || refreshPending
      ? undefined
      : refreshExpectation.outcome === "conflict"
        ? "Os acessos mudaram. O estado atual foi recarregado para uma nova revisão."
        : user.accountVersion === refreshExpectation.minimumAccountVersion
          ? "Acesso atualizado e sessões incompatíveis encerradas."
          : "O estado mais recente dos acessos foi carregado. Revise as alterações antes de agir.";
  const refreshAccess = () => {
    setRefreshTimedOut(false);
    setRefreshAttempt((attempt) => attempt + 1);
    router.refresh();
  };
  useEffect(() => {
    if (!refreshPending) return;
    const deadline = window.setTimeout(() => setRefreshTimedOut(true), 10_000);
    return () => window.clearTimeout(deadline);
  }, [refreshAttempt, refreshPending]);
  const pendingCommand = useRef<BackofficeAccessCommand>(undefined);
  const mutation = useMutation({
    mutationFn: () => {
      if (pendingCommand.current === undefined) {
        throw new Error("A alteração de acesso não possui solicitação idempotente preparada.");
      }
      return executeBackofficeUserCommand(pendingCommand.current);
    },
    networkMode: "always",
    onError: (error) => {
      if (isStaleBackofficeError(error)) {
        setRefreshExpectation({
          minimumAccountVersion:
            (pendingCommand.current?.payload.expectedAccountVersion ?? user.accountVersion) + 1,
          outcome: "conflict",
          userId: user.id,
        });
        pendingCommand.current = undefined;
        setNeedsReauthentication(false);
        setSelected(undefined);
        setNotice(undefined);
        refreshAccess();
        return;
      }
      const ambiguous = isAmbiguousBackofficeError(error);
      if (
        ambiguous &&
        pendingCommand.current?.action === "backoffice.access.revokeAdmin" &&
        pendingCommand.current.payload.userId === session.scope
      ) {
        recomposeSession();
        return;
      }
      if (!ambiguous) pendingCommand.current = undefined;
      if (error instanceof BackofficeClientError && error.code === "REAUTHENTICATION_REQUIRED") {
        setNeedsReauthentication(true);
      }
    },
    onSuccess: (result) => {
      const revokedCurrentAdmin =
        pendingCommand.current?.action === "backoffice.access.revokeAdmin" &&
        pendingCommand.current.payload.userId === session.scope;
      pendingCommand.current = undefined;
      if (revokedCurrentAdmin) {
        recomposeSession();
        return;
      }
      setNeedsReauthentication(false);
      setSelected(undefined);
      setNotice(undefined);
      setRefreshExpectation({
        minimumAccountVersion: result.accountVersion,
        outcome: "applied",
        userId: result.id,
      });
      refreshAccess();
    },
  });
  const retryAvailable = mutation.isError && isAmbiguousBackofficeError(mutation.error);

  const actions = (
    <section
      aria-label={transitions.length === 0 ? undefined : "Ações de acesso"}
      className={styles.pageStack}
    >
      {(notice ?? verifiedNotice) === undefined ? null : <Alert>{notice ?? verifiedNotice}</Alert>}
      {needsReauthentication ? (
        <AccessReauthentication
          onConfirmed={(nextSession) => {
            pendingCommand.current = undefined;
            setNeedsReauthentication(false);
            setSelected(undefined);
            setNotice(
              "Identidade confirmada. Desbloqueie novamente o runtime e revise a alteração.",
            );
            reconcileSuccessfulBackofficeReauthentication({
              currentSession: session,
              nextSession,
              notifyPeerSessionsChanged: notifyBackofficePeerSessionsChanged,
              queryClient,
              recomposeSession,
            });
          }}
          onSessionBoundary={recomposeSession}
          session={session}
        />
      ) : null}
      <div className={styles.actions}>
        {transitions.map((transition) => (
          <Button
            disabled={!interactive || mutation.isPending || retryAvailable || refreshPending}
            key={transition.action}
            onClick={() => {
              if (refreshPending) return;
              pendingCommand.current = undefined;
              mutation.reset();
              setNotice(undefined);
              setRefreshExpectation(undefined);
              setSelected(transition);
            }}
            variant="secondary"
          >
            {transition.buttonLabel}
          </Button>
        ))}
      </div>
      {selected === undefined ? null : (
        <section aria-labelledby="access-confirmation" className={styles.confirmation}>
          <h2 id="access-confirmation">Confirmar alteração de acesso</h2>
          <p>{selected.confirmation}</p>
          <p>
            Alvo: {user.emailMasked}. O banco revalida a versão e protege o último administrador
            ativo.
          </p>
          {mutation.isError ? <Alert variant="error">{errorMessage(mutation.error)}</Alert> : null}
          <div className={styles.actions}>
            <Button
              loading={mutation.isPending}
              loadingLabel="Aplicando"
              onClick={() => {
                pendingCommand.current ??= {
                  action: selected.action,
                  expectedScope: session.scope,
                  idempotencyKey: crypto.randomUUID(),
                  payload: {
                    expectedAccountVersion: user.accountVersion,
                    userId: user.id,
                  },
                };
                mutation.mutate();
              }}
            >
              {retryAvailable ? "Repetir mesma tentativa" : "Confirmar alteração"}
            </Button>
            <Button
              disabled={mutation.isPending || retryAvailable}
              onClick={() => {
                pendingCommand.current = undefined;
                mutation.reset();
                setSelected(undefined);
              }}
              variant="ghost"
            >
              Cancelar
            </Button>
          </div>
        </section>
      )}
    </section>
  );

  return (
    <>
      {refreshPending ? (
        <Alert variant={refreshTimedOut ? "error" : "status"}>
          <p>
            {refreshExpectation?.outcome === "applied"
              ? "A alteração foi aplicada. "
              : "Os acessos mudaram. "}
            {refreshTimedOut
              ? "Não foi possível verificar o estado atual. Tente uma nova leitura antes de agir."
              : "Verificando o estado atual antes de liberar novas ações…"}
          </p>
          {refreshTimedOut ? (
            <Button onClick={refreshAccess} variant="secondary">
              Tentar verificar acessos novamente
            </Button>
          ) : null}
        </Alert>
      ) : (
        children
      )}
      {actions}
    </>
  );
}
