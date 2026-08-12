"use client";

import type { IdentitySession } from "@set-livre/contracts";
import { Alert, Button, Stack } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  clearIdentityAndAccountQueryCache,
  seedAuthoritativeIdentitySession,
} from "./account-query-keys";
import styles from "./account.module.css";
import { IdentityApiError, logoutIdentity, readIdentitySession } from "./identity-api";
import {
  IdentitySessionScopeChangedError,
  identityQueryKeys,
  identitySessionCanRender,
  identitySessionForScope,
  identitySessionMatchesScope,
} from "./identity-query-keys";

type AuthenticatedIdentitySession = Extract<IdentitySession, { authenticated: true }>;

type AccountSecurityPanelProps = {
  initialSession: AuthenticatedIdentitySession;
};

function PreparedAccountSecurityPanel({ initialSession }: AccountSecurityPanelProps) {
  const queryClient = useQueryClient();
  const userId = initialSession.userId;
  const queryKey = useMemo(() => identityQueryKeys.session(userId), [userId]);
  const [sessionTransitionStarted, setSessionTransitionStarted] = useState(false);
  const sessionQuery = useQuery({
    initialData: initialSession,
    queryFn: async () => identitySessionForScope(await readIdentitySession(), userId),
    queryKey,
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 30_000,
  });
  const logoutMutation = useMutation({
    mutationFn: () => logoutIdentity(userId),
    networkMode: "always",
    onError: () => {
      queryClient.clear();
      window.location.replace("/entrar?saida=verificar");
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.replace("/entrar");
    },
  });
  const observedSession = sessionQuery.data;
  const sessionCanRender =
    observedSession !== undefined &&
    identitySessionCanRender(observedSession, userId, sessionQuery.fetchStatus);
  const observedScopeChanged =
    observedSession !== undefined && !identitySessionMatchesScope(observedSession, userId);
  const authoritativeScopeChanged = sessionQuery.error instanceof IdentitySessionScopeChangedError;

  useEffect(() => {
    if (!observedScopeChanged && !authoritativeScopeChanged) return;
    clearIdentityAndAccountQueryCache(queryClient);
    window.location.reload();
  }, [authoritativeScopeChanged, observedScopeChanged, queryClient]);

  if (
    sessionTransitionStarted ||
    (observedSession !== undefined && !sessionCanRender) ||
    authoritativeScopeChanged
  ) {
    return <Alert>Validando sua sessão antes de exibir dados privados…</Alert>;
  }

  if (sessionQuery.isError || observedSession?.authenticated !== true) {
    const message =
      sessionQuery.error instanceof IdentityApiError
        ? sessionQuery.error.message
        : "Não foi possível validar sua sessão.";
    return (
      <Stack space={4}>
        <Alert title="Segurança indisponível" variant="error">
          {message}
        </Alert>
        <div className={styles.actions}>
          <Button
            loading={sessionQuery.isFetching}
            loadingLabel="Validando sessão"
            onClick={() => {
              void sessionQuery.refetch();
            }}
            variant="secondary"
          >
            Tentar novamente
          </Button>
        </div>
      </Stack>
    );
  }

  return (
    <Stack space={6}>
      {observedSession.status === "suspended" ? (
        <Alert title="Conta suspensa" variant="error">
          A conta não pode acessar áreas privadas do produto. As ações de segurança permanecem
          disponíveis.
        </Alert>
      ) : (
        <Alert title="Sessão protegida">Sua identidade foi revalidada no servidor.</Alert>
      )}

      <section className={styles.section} aria-labelledby="security-email-title">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle} id="security-email-title">
            E-mail de acesso
          </h2>
          <p className={styles.sectionDescription}>
            O e-mail pertence ao Supabase Auth e é somente leitura nesta tela.
          </p>
        </div>
        <div className={styles.securitySummary}>
          <div className={styles.summaryItem}>
            <p className={styles.summaryLabel}>E-mail autenticado</p>
            <p className={styles.summaryValue}>{observedSession.email}</p>
          </div>
          <div className={styles.summaryItem}>
            <p className={styles.summaryLabel}>Estado da conta</p>
            <p className={styles.summaryValue}>
              {observedSession.status === "active" ? "Ativa" : "Suspensa"}
            </p>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="security-actions-title">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle} id="security-actions-title">
            Senha e sessão
          </h2>
          <p className={styles.sectionDescription}>
            A troca de senha usa o fluxo de recuperação já validado e encerra a sessão atual quando
            aplicável.
          </p>
        </div>
        <div className={styles.actions}>
          <Link className={styles.textLink} href="/recuperar-senha">
            Recuperar ou trocar senha
          </Link>
          <Button
            loading={logoutMutation.isPending}
            loadingLabel="Saindo"
            onClick={() => {
              setSessionTransitionStarted(true);
              logoutMutation.mutate();
            }}
            variant="secondary"
          >
            Sair desta conta
          </Button>
        </div>
      </section>
    </Stack>
  );
}

export function AccountSecurityPanel({ initialSession }: AccountSecurityPanelProps) {
  const queryClient = useQueryClient();
  const [preparedInitialSession, setPreparedInitialSession] =
    useState<AuthenticatedIdentitySession>();
  const seedIsCurrent = preparedInitialSession === initialSession;

  useEffect(() => {
    let active = true;
    seedAuthoritativeIdentitySession(queryClient, initialSession);
    queueMicrotask(() => {
      if (active) setPreparedInitialSession(initialSession);
    });
    return () => {
      active = false;
    };
  }, [initialSession, queryClient]);

  if (!seedIsCurrent) {
    return <Alert>Validando sua sessão antes de exibir dados privados…</Alert>;
  }

  return <PreparedAccountSecurityPanel initialSession={preparedInitialSession} />;
}
