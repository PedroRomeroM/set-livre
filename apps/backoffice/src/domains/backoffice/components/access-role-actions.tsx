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
import { useRef, useState } from "react";

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
import { notifyBackofficeSessionChanged } from "./session-events";
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
  notifySessionChanged,
  queryClient,
  recomposeSession,
}: Readonly<{
  currentSession: AuthenticatedSession;
  nextSession: AuthenticatedSession;
  notifySessionChanged: () => void;
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
  notifySessionChanged();
  return "published";
}

export type BackofficeAccessTransition = Readonly<{
  action: AccessAction;
  buttonLabel: string;
  confirmation: string;
}>;

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
  session,
  transitions,
  user,
}: {
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
        pendingCommand.current = undefined;
        setNeedsReauthentication(false);
        setSelected(undefined);
        setNotice("Os acessos mudaram. O estado atual foi recarregado para uma nova revisão.");
        router.refresh();
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
    onSuccess: () => {
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
      setNotice("Acesso atualizado e sessões incompatíveis encerradas.");
      router.refresh();
    },
  });
  const retryAvailable = mutation.isError && isAmbiguousBackofficeError(mutation.error);

  return (
    <section aria-label="Ações de acesso" className={styles.pageStack}>
      {notice === undefined ? null : <Alert>{notice}</Alert>}
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
              notifySessionChanged: notifyBackofficeSessionChanged,
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
            disabled={!interactive || mutation.isPending || retryAvailable}
            key={transition.action}
            onClick={() => {
              pendingCommand.current = undefined;
              mutation.reset();
              setNotice(undefined);
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
}
