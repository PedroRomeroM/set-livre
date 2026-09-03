"use client";

import {
  type BackofficePiiReason,
  type BackofficeSession,
  type BackofficeUserPii,
  type BackofficeUserRevealPiiCommand,
  type BackofficeUserStatusCommand,
  type BackofficeUserSummary,
} from "@set-livre/contracts";
import { Alert, Button, ButtonLink, Checkbox, Field, Input, Select } from "@set-livre/ui";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  BackofficeClientError,
  executeBackofficeUserCommand,
  isAmbiguousBackofficeError,
  isStaleBackofficeError,
  listBackofficeUsersClient,
  revealBackofficePiiWithoutCaching,
} from "./backoffice-api";
import { backofficeFilterFingerprint, backofficeQueryKeys } from "./query-keys";
import { useBackofficeHydrated } from "./use-backoffice-hydrated";
import styles from "./backoffice.module.css";

type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;
type Mode = "access" | "users";

const reasonLabels: Record<BackofficePiiReason, string> = {
  identity_verification: "Verificação de identidade",
  legal_request: "Solicitação legal",
  security_investigation: "Investigação de segurança",
  support_case: "Atendimento de suporte",
};

function errorMessage(error: unknown) {
  if (isAmbiguousBackofficeError(error)) {
    return "O resultado não pôde ser confirmado. Repita a mesma tentativa para consultar o resultado idempotente.";
  }
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível concluir agora. Tente novamente.";
}

function UserPiiReveal({
  interactive,
  session,
  user,
}: {
  interactive: boolean;
  session: AuthenticatedSession;
  user: BackofficeUserSummary;
}) {
  const [reason, setReason] = useState<BackofficePiiReason>("support_case");
  const [pii, setPii] = useState<BackofficeUserPii>();
  const [retryAvailable, setRetryAvailable] = useState(false);
  const pendingReveal = useRef<BackofficeUserRevealPiiCommand>(undefined);
  const reveal = useMutation({
    gcTime: 0,
    mutationFn: () => {
      if (pendingReveal.current === undefined) {
        throw new Error("A revelação não possui solicitação idempotente preparada.");
      }
      return revealBackofficePiiWithoutCaching(pendingReveal.current, (revealedPii) => {
        if (document.visibilityState === "visible") setPii(revealedPii);
      });
    },
    networkMode: "always",
    onError: (error) => {
      const ambiguous = isAmbiguousBackofficeError(error);
      setRetryAvailable(ambiguous);
      if (!ambiguous) pendingReveal.current = undefined;
    },
    onSuccess: () => {
      pendingReveal.current = undefined;
      setRetryAvailable(false);
    },
  });

  useEffect(() => {
    if (pii === undefined) return;
    const timeout = window.setTimeout(() => setPii(undefined), 60_000);
    const hide = () => {
      if (document.visibilityState === "hidden") setPii(undefined);
    };
    hide();
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [pii]);

  return (
    <div className={styles.confirmation}>
      <Field label="Motivo auditado">
        <Select
          disabled={!interactive || retryAvailable}
          onChange={(event) => setReason(event.target.value as BackofficePiiReason)}
          value={reason}
        >
          {Object.entries(reasonLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <div className={styles.actions}>
        <Button
          disabled={!interactive}
          loading={reveal.isPending}
          loadingLabel="Revelando"
          onClick={() => {
            setRetryAvailable(false);
            pendingReveal.current ??= {
              action: "backoffice.user.revealPii",
              expectedScope: session.scope,
              idempotencyKey: crypto.randomUUID(),
              payload: { reason, userId: user.id },
            };
            reveal.mutate();
          }}
          variant="secondary"
        >
          {retryAvailable ? "Repetir mesma revelação" : "Revelar dados por 60 segundos"}
        </Button>
        {pii === undefined ? null : (
          <Button onClick={() => setPii(undefined)} variant="ghost">
            Ocultar agora
          </Button>
        )}
      </div>
      {reveal.isError ? <Alert variant="error">{errorMessage(reveal.error)}</Alert> : null}
      {pii === undefined ? null : (
        <section aria-label={`Dados revelados de ${user.emailMasked}`} className={styles.piiPanel}>
          <p className={styles.help}>
            Conteúdo temporário, fora do cache e limpo ao ocultar a aba.
          </p>
          <dl className={styles.definitionList}>
            <dt>E-mail</dt>
            <dd>{pii.email}</dd>
            <dt>Nome</dt>
            <dd>{pii.name ?? "Não informado"}</dd>
            <dt>Telefone</dt>
            <dd>{pii.phoneE164 ?? "Não informado"}</dd>
            <dt>Documento fiscal</dt>
            <dd>{pii.taxId ?? "Não informado"}</dd>
            <dt>Documento adicional</dt>
            <dd>{pii.additionalDocument ?? "Não informado"}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}

function UserCard({
  interactive,
  mode,
  onStatusChange,
  session,
  statusChangeDisabled,
  user,
}: {
  interactive: boolean;
  mode: Mode;
  onStatusChange: (user: BackofficeUserSummary) => void;
  session: AuthenticatedSession;
  statusChangeDisabled: boolean;
  user: BackofficeUserSummary;
}) {
  return (
    <article className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h2>Conta {user.emailMasked}</h2>
          <p className={styles.muted}>Identificador …{user.id.slice(-8)}</p>
        </div>
        <span className={styles.badge} data-state={user.status}>
          {user.status === "active" ? "Ativo" : "Suspenso"}
        </span>
      </div>
      <p className={styles.metadata}>
        Criado em{" "}
        {new Date(user.createdAt).toLocaleDateString("pt-BR", {
          timeZone: "America/Sao_Paulo",
        })}{" "}
        · versão {user.accountVersion}
      </p>
      {mode === "users" ? (
        <>
          <Button
            disabled={statusChangeDisabled}
            onClick={() => onStatusChange(user)}
            variant={user.status === "active" ? "secondary" : "primary"}
          >
            {user.status === "active" ? "Revisar suspensão" : "Revisar restauração"}
          </Button>
          <UserPiiReveal interactive={interactive} session={session} user={user} />
        </>
      ) : (
        <ButtonLink href={`/acessos/${user.id}`} variant="secondary">
          Gerenciar acesso
        </ButtonLink>
      )}
    </article>
  );
}

export function UserDirectory({ mode, session }: { mode: Mode; session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const interactive = useBackofficeHydrated();
  const [draftQuery, setDraftQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState({ fingerprint: "empty", query: "" });
  const [statusTarget, setStatusTarget] = useState<BackofficeUserSummary>();
  const [statusImpactConfirmed, setStatusImpactConfirmed] = useState(false);
  const [statusRetryAvailable, setStatusRetryAvailable] = useState(false);
  const [notice, setNotice] = useState<string>();
  const searchInFlight = useRef(false);
  const [searchPending, setSearchPending] = useState(false);
  const pendingStatusCommand = useRef<BackofficeUserStatusCommand>(undefined);
  const users = useInfiniteQuery({
    initialPageParam: null as string | null,
    queryKey: backofficeQueryKeys.users(session.scope, activeFilter.fingerprint),
    queryFn: ({ pageParam }) =>
      listBackofficeUsersClient({
        cursor: pageParam,
        ...(activeFilter.query === "" ? {} : { query: activeFilter.query }),
      }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const invalidateUsers = () =>
    queryClient.invalidateQueries({ queryKey: ["backoffice", "users", session.scope] });
  const resetUsers = () =>
    queryClient.resetQueries({ queryKey: ["backoffice", "users", session.scope] });
  const statusMutation = useMutation({
    mutationFn: () => {
      if (pendingStatusCommand.current === undefined) {
        throw new Error("A alteração de status não possui solicitação idempotente preparada.");
      }
      return executeBackofficeUserCommand(pendingStatusCommand.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isStaleBackofficeError(error)) {
        pendingStatusCommand.current = undefined;
        setStatusImpactConfirmed(false);
        setStatusRetryAvailable(false);
        setStatusTarget(undefined);
        setNotice("A conta mudou. A lista foi recarregada; revise o estado atual antes de agir.");
        await resetUsers();
        return;
      }
      const ambiguous = isAmbiguousBackofficeError(error);
      setStatusRetryAvailable(ambiguous);
      if (!ambiguous) pendingStatusCommand.current = undefined;
    },
    onSuccess: async (user) => {
      pendingStatusCommand.current = undefined;
      setStatusImpactConfirmed(false);
      setStatusRetryAvailable(false);
      setStatusTarget(undefined);
      setNotice(
        user.status === "active"
          ? "Usuário restaurado."
          : "Usuário suspenso e sessões operacionais encerradas.",
      );
      await invalidateUsers();
    },
  });
  const items = users.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section
      aria-busy={!interactive}
      aria-labelledby={`${mode}-title`}
      className={styles.pageStack}
      inert={!interactive}
    >
      <header>
        <p className={styles.eyebrow}>{mode === "users" ? "Contas" : "Menor privilégio"}</p>
        <h1 id={`${mode}-title`}>{mode === "users" ? "Usuários" : "Acessos"}</h1>
        <p>
          {mode === "users"
            ? "Busque, suspenda ou restaure contas e revele dados somente com motivo auditado."
            : "Busque uma conta e abra o detalhe autorizado para revisar seus acessos."}
        </p>
      </header>
      {notice === undefined ? null : <Alert>{notice}</Alert>}
      <form
        aria-busy={!interactive || searchPending}
        className={styles.toolbar}
        inert={!interactive}
        method="post"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (statusMutation.isPending || searchInFlight.current) return;
          searchInFlight.current = true;
          setSearchPending(true);
          pendingStatusCommand.current = undefined;
          statusMutation.reset();
          setNotice(undefined);
          setStatusImpactConfirmed(false);
          setStatusRetryAvailable(false);
          setStatusTarget(undefined);
          try {
            const normalized = draftQuery.trim();
            const fingerprint =
              normalized === "" ? "empty" : await backofficeFilterFingerprint(normalized);
            setActiveFilter({ fingerprint, query: normalized });
          } catch {
            setNotice("Não foi possível preparar a busca com segurança. Tente novamente.");
          } finally {
            searchInFlight.current = false;
            setSearchPending(false);
          }
        }}
      >
        <fieldset
          className={`${styles.secureFormBoundary} ${styles.toolbarBoundary}`}
          disabled={!interactive || statusMutation.isPending || searchPending}
        >
          <Field
            description="Prefixo de e-mail ou UUID completo. Nome exige revelação auditada; o filtro não é colocado na URL."
            label="Buscar usuários"
          >
            <Input
              disabled={!interactive || statusMutation.isPending || searchPending}
              name="query"
              onChange={(event) => setDraftQuery(event.target.value)}
              value={draftQuery}
            />
          </Field>
          <Button
            disabled={!interactive || statusMutation.isPending || searchPending}
            loading={searchPending}
            loadingLabel="Buscando"
            type="submit"
          >
            Buscar
          </Button>
        </fieldset>
      </form>
      {users.isPending ? <p role="status">Carregando usuários…</p> : null}
      {users.isError ? <Alert variant="error">{errorMessage(users.error)}</Alert> : null}
      {!users.isPending && !users.isError && items.length === 0 ? (
        <p className={styles.empty}>Nenhum usuário encontrado.</p>
      ) : null}
      <div className={styles.cardGrid}>
        {items.map((user) => (
          <UserCard
            interactive={interactive}
            key={user.id}
            mode={mode}
            onStatusChange={(target) => {
              pendingStatusCommand.current = undefined;
              statusMutation.reset();
              setNotice(undefined);
              setStatusImpactConfirmed(false);
              setStatusRetryAvailable(false);
              setStatusTarget(target);
            }}
            session={session}
            statusChangeDisabled={!interactive || statusMutation.isPending || statusRetryAvailable}
            user={user}
          />
        ))}
      </div>
      {statusTarget === undefined ? null : (
        <section aria-labelledby="status-confirmation" className={styles.confirmation}>
          <h2 id="status-confirmation">
            Confirmar {statusTarget.status === "active" ? "suspensão" : "restauração"}
          </h2>
          <p>
            {statusTarget.status === "active"
              ? "A conta perderá acesso e as sessões administrativas serão fechadas. O histórico permanece."
              : "A conta volta a executar ações permitidas pelo próprio perfil e papéis."}
          </p>
          <Checkbox
            checked={statusImpactConfirmed}
            disabled={!interactive || statusMutation.isPending || statusRetryAvailable}
            label="Revisei o impacto desta alteração"
            onChange={(event) => setStatusImpactConfirmed(event.target.checked)}
            required
          />
          {statusMutation.isError ? (
            <Alert variant="error">{errorMessage(statusMutation.error)}</Alert>
          ) : null}
          <div className={styles.actions}>
            <Button
              disabled={!interactive || !statusImpactConfirmed || statusMutation.isPending}
              loading={statusMutation.isPending}
              loadingLabel="Aplicando"
              onClick={() => {
                pendingStatusCommand.current ??= {
                  action:
                    statusTarget.status === "active"
                      ? "backoffice.user.suspend"
                      : "backoffice.user.restore",
                  expectedScope: session.scope,
                  idempotencyKey: crypto.randomUUID(),
                  payload: {
                    expectedAccountVersion: statusTarget.accountVersion,
                    userId: statusTarget.id,
                  },
                };
                statusMutation.mutate();
              }}
            >
              {statusRetryAvailable ? "Repetir mesma tentativa" : "Confirmar"}
            </Button>
            <Button
              disabled={!interactive || statusMutation.isPending || statusRetryAvailable}
              onClick={() => {
                pendingStatusCommand.current = undefined;
                statusMutation.reset();
                setStatusImpactConfirmed(false);
                setStatusRetryAvailable(false);
                setStatusTarget(undefined);
              }}
              variant="ghost"
            >
              Cancelar
            </Button>
          </div>
        </section>
      )}
      {users.hasNextPage ? (
        <div className={styles.pagination}>
          <Button
            disabled={!interactive}
            loading={users.isFetchingNextPage}
            loadingLabel="Carregando"
            onClick={() => users.fetchNextPage()}
            variant="secondary"
          >
            Carregar mais
          </Button>
        </div>
      ) : null}
    </section>
  );
}
