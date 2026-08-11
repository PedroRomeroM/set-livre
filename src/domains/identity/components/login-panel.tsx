"use client";

import {
  identityLoginPayloadSchema,
  type IdentityLoginPayload,
  type IdentitySession,
} from "@set-livre/contracts";
import { Alert, Button, Field, Input, PasswordInput, Stack } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { fieldErrorProp, firstFieldErrors, formValue, type FieldErrors } from "./form-utils";
import {
  IdentityApiError,
  loginIdentity,
  logoutIdentity,
  readIdentitySession,
} from "./identity-api";
import {
  IdentitySessionScopeChangedError,
  identityQueryKeys,
  identitySessionCanRender,
  identitySessionForScope,
  identitySessionMatchesScope,
  identitySessionScope,
  type IdentitySessionScope,
} from "./identity-query-keys";
import styles from "./identity.module.css";

type LoginPanelProps = {
  initialSession: IdentitySession;
  logoutNeedsVerification: boolean;
};

function accountTypeLabel(session: Extract<IdentitySession, { authenticated: true }>) {
  return session.personType === "individual" ? "Pessoa física" : "Pessoa jurídica";
}

function replaceIdentitySessionCache(queryClient: QueryClient, session: IdentitySession) {
  queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
  queryClient.setQueryData(identityQueryKeys.session(identitySessionScope(session)), session);
}

function redactIdentitySessionCacheForReload(
  queryClient: QueryClient,
  previousScope: IdentitySessionScope,
) {
  queryClient.clear();
  queryClient.setQueryData(identityQueryKeys.session(previousScope), { authenticated: false });
}

function AuthenticatedPanel({
  logoutNeedsVerification,
  onSessionTransition,
  session,
}: {
  logoutNeedsVerification: boolean;
  onSessionTransition: () => void;
  session: Extract<IdentitySession, { authenticated: true }>;
}) {
  const queryClient = useQueryClient();
  const logoutMutation = useMutation({
    mutationFn: logoutIdentity,
    onSuccess: () => {
      onSessionTransition();
      redactIdentitySessionCacheForReload(queryClient, identitySessionScope(session));
      window.location.replace("/entrar");
    },
    onError: () => {
      onSessionTransition();
      redactIdentitySessionCacheForReload(queryClient, identitySessionScope(session));
      window.location.replace("/entrar?saida=verificar");
    },
  });
  const apiError =
    logoutMutation.error instanceof IdentityApiError ? logoutMutation.error : undefined;

  if (logoutMutation.isError) {
    return (
      <Alert title="Não foi possível confirmar a saída" variant="error">
        {apiError?.message ?? "Sua sessão será validada novamente antes de exibir dados privados."}
      </Alert>
    );
  }

  return (
    <Stack space={5}>
      {logoutNeedsVerification ? (
        <Alert title="A sessão ainda está ativa" variant="error">
          Não foi possível confirmar a saída. Tente novamente quando estiver pronto.
        </Alert>
      ) : null}

      {session.status === "suspended" ? (
        <Alert title="Acesso ao produto suspenso" variant="error">
          Sua autenticação foi confirmada, mas esta conta não pode acessar as áreas privadas.
        </Alert>
      ) : (
        <Alert title="Sessão ativa">Sua identidade foi validada no servidor.</Alert>
      )}

      <div className={styles.accountSummary}>
        <div>
          <p className={styles.accountLabel}>E-mail autenticado</p>
          <p className={styles.accountValue}>{session.email}</p>
        </div>
        <div>
          <p className={styles.accountLabel}>Tipo de cadastro</p>
          <p className={styles.accountValue}>{accountTypeLabel(session)}</p>
        </div>
      </div>

      {!session.profileCompleted && session.status === "active" ? (
        <p className={styles.supportingText}>
          O cadastro básico está confirmado. O perfil detalhado ainda não foi concluído.
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button
          loading={logoutMutation.isPending}
          loadingLabel="Saindo"
          onClick={() => logoutMutation.mutate()}
          variant="secondary"
        >
          Sair
        </Button>
      </div>
    </Stack>
  );
}

function LoginForm({ logoutWasVerified }: { logoutWasVerified: boolean }) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const pendingLogin = useRef<IdentityLoginPayload>(undefined);
  const mutation = useMutation({
    mutationFn: () => {
      if (pendingLogin.current === undefined) {
        throw new Error("O login não possui payload efêmero.");
      }
      return loginIdentity(pendingLogin.current);
    },
    onSettled: () => {
      pendingLogin.current = undefined;
    },
    onSuccess: (result) => {
      replaceIdentitySessionCache(queryClient, result.session);
      window.location.assign(result.redirectTo);
    },
  });

  function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.reset();
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const parsed = identityLoginPayloadSchema.safeParse({
      email: formValue(form, "email"),
      password: formValue(form, "password"),
    });
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }
    pendingLogin.current = parsed.data satisfies IdentityLoginPayload;
    mutation.mutate();
  }

  const apiError = mutation.error instanceof IdentityApiError ? mutation.error : undefined;
  const visibleFieldErrors = apiError?.fieldErrors ?? fieldErrors;

  return (
    <form className={styles.form} noValidate onSubmit={submitLogin}>
      {logoutWasVerified ? (
        <Alert title="Sessão encerrada">
          A revalidação confirmou que não há uma sessão ativa neste navegador.
        </Alert>
      ) : null}

      {apiError === undefined ? null : (
        <Alert title="Não foi possível entrar" variant="error">
          {apiError.message}
        </Alert>
      )}

      <Field {...fieldErrorProp(visibleFieldErrors, "email")} label="E-mail" required>
        <Input
          autoComplete="email"
          disabled={mutation.isPending}
          inputMode="email"
          maxLength={254}
          name="email"
          spellCheck={false}
          type="email"
        />
      </Field>

      <Field {...fieldErrorProp(visibleFieldErrors, "password")} label="Senha" required>
        <PasswordInput
          autoComplete="current-password"
          disabled={mutation.isPending}
          maxLength={128}
          name="password"
        />
      </Field>

      <div className={styles.actions}>
        <Button loading={mutation.isPending} loadingLabel="Entrando" type="submit">
          Entrar
        </Button>
        <Link className={styles.textLink} href="/recuperar-senha">
          Esqueci minha senha
        </Link>
      </div>

      <p className={styles.supportingText}>
        Ainda não tem uma conta?{" "}
        <Link className={styles.textLink} href="/cadastro">
          Criar conta
        </Link>
      </p>
    </form>
  );
}

function PreparedLoginPanel({ initialSession, logoutNeedsVerification }: LoginPanelProps) {
  const queryClient = useQueryClient();
  const [sessionTransitionStarted, setSessionTransitionStarted] = useState(false);
  const sessionScope = identitySessionScope(initialSession);
  const sessionQueryKey = useMemo(() => identityQueryKeys.session(sessionScope), [sessionScope]);
  const sessionQuery = useQuery({
    initialData: initialSession,
    queryFn: async () => identitySessionForScope(await readIdentitySession(), sessionScope),
    queryKey: sessionQueryKey,
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 30_000,
  });
  const observedSession = sessionQuery.data;
  const observedSessionCanRender =
    observedSession !== undefined &&
    identitySessionCanRender(observedSession, sessionScope, sessionQuery.fetchStatus);
  const observedScopeChanged =
    observedSession !== undefined && !identitySessionMatchesScope(observedSession, sessionScope);
  const authoritativeScopeChanged = sessionQuery.error instanceof IdentitySessionScopeChangedError;

  useEffect(() => {
    if ((!observedScopeChanged && !authoritativeScopeChanged) || sessionTransitionStarted) {
      return;
    }
    redactIdentitySessionCacheForReload(queryClient, sessionScope);
    window.location.replace("/entrar");
  }, [
    authoritativeScopeChanged,
    observedScopeChanged,
    queryClient,
    sessionScope,
    sessionTransitionStarted,
  ]);

  if (sessionTransitionStarted || (observedSession !== undefined && !observedSessionCanRender)) {
    return <Alert>Validando sua sessão…</Alert>;
  }

  if (sessionQuery.isError || observedSession === undefined) {
    const message =
      sessionQuery.error instanceof IdentityApiError
        ? sessionQuery.error.message
        : "Não foi possível validar sua sessão.";
    return (
      <Stack space={4}>
        <Alert title="Sessão indisponível" variant="error">
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

  return observedSession.authenticated ? (
    <AuthenticatedPanel
      logoutNeedsVerification={logoutNeedsVerification}
      onSessionTransition={() => {
        setSessionTransitionStarted(true);
      }}
      session={observedSession}
    />
  ) : (
    <LoginForm logoutWasVerified={logoutNeedsVerification} />
  );
}

export function LoginPanel({ initialSession, logoutNeedsVerification }: LoginPanelProps) {
  const queryClient = useQueryClient();
  const sessionScope = identitySessionScope(initialSession);
  const sessionQueryKey = useMemo(() => identityQueryKeys.session(sessionScope), [sessionScope]);
  const [preparedInitialSession, setPreparedInitialSession] = useState<IdentitySession>();
  const seedIsCurrent = preparedInitialSession === initialSession;

  useEffect(() => {
    let active = true;
    queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });
    queryClient.setQueryData(sessionQueryKey, initialSession);
    queueMicrotask(() => {
      if (active) {
        setPreparedInitialSession(initialSession);
      }
    });
    return () => {
      active = false;
    };
  }, [initialSession, queryClient, sessionQueryKey]);

  if (!seedIsCurrent) {
    return <Alert>Validando sua sessão…</Alert>;
  }

  return (
    <PreparedLoginPanel
      initialSession={preparedInitialSession}
      logoutNeedsVerification={logoutNeedsVerification}
    />
  );
}
