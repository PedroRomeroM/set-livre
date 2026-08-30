"use client";

import {
  type BackofficeAccessSetRoleCommand,
  type BackofficePiiReason,
  type BackofficeSession,
  type BackofficeUserPii,
  type BackofficeUserRevealPiiCommand,
  type BackofficeUserStatusCommand,
  type BackofficeUserSummary,
  type PlatformRole,
} from "@set-livre/contracts";
import { Alert, Button, Checkbox, Field, Input, PasswordInput, Select } from "@set-livre/ui";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  BackofficeClientError,
  executeBackofficeUserCommand,
  isAmbiguousBackofficeError,
  isStaleBackofficeError,
  listBackofficeUsersClient,
  loginBackofficeClient,
  revealBackofficePiiWithoutCaching,
} from "./backoffice-api";
import { backofficeFilterFingerprint, backofficeQueryKeys } from "./query-keys";
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
  session,
  user,
}: {
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
      return revealBackofficePiiWithoutCaching(pendingReveal.current, setPii);
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
          disabled={retryAvailable}
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
  mode,
  onRoleChange,
  onStatusChange,
  session,
  user,
}: {
  mode: Mode;
  onRoleChange: (user: BackofficeUserSummary, role: PlatformRole, enabled: boolean) => void;
  onStatusChange: (user: BackofficeUserSummary) => void;
  session: AuthenticatedSession;
  user: BackofficeUserSummary;
}) {
  const isAdmin = session.roles.includes("admin");
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
        Criado em {new Date(user.createdAt).toLocaleDateString("pt-BR")} · versão{" "}
        {user.accountVersion}
      </p>
      <div aria-label="Papéis atuais" className={styles.roleList}>
        {user.roles.length === 0 ? (
          <span className={styles.muted}>Sem acesso operacional</span>
        ) : (
          user.roles.map((role) => (
            <span className={styles.badge} key={role}>
              {role}
            </span>
          ))
        )}
      </div>
      {mode === "users" ? (
        <>
          <Button
            onClick={() => onStatusChange(user)}
            variant={user.status === "active" ? "secondary" : "primary"}
          >
            {user.status === "active" ? "Revisar suspensão" : "Revisar restauração"}
          </Button>
          <UserPiiReveal session={session} user={user} />
        </>
      ) : isAdmin ? (
        <div className={styles.roleList}>
          {(["support", "admin"] as const).map((role) => {
            const enabled = user.roles.includes(role);
            return (
              <Button
                key={role}
                onClick={() => onRoleChange(user, role, !enabled)}
                variant={enabled ? "secondary" : "ghost"}
              >
                {enabled ? `Revogar ${role}` : `Conceder ${role}`}
              </Button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

function Reauthentication({
  session,
  onConfirmed,
}: {
  session: AuthenticatedSession;
  onConfirmed: () => void;
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
    onSuccess: (nextSession) => {
      if (nextSession.authenticated) onConfirmed();
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
      <p>Alterações de papel exigem uma autenticação realizada nos últimos cinco minutos.</p>
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

export function UserDirectory({ mode, session }: { mode: Mode; session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const [draftQuery, setDraftQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState({ fingerprint: "empty", query: "" });
  const [statusTarget, setStatusTarget] = useState<BackofficeUserSummary>();
  const [statusImpactConfirmed, setStatusImpactConfirmed] = useState(false);
  const [roleTarget, setRoleTarget] = useState<{
    enabled: boolean;
    role: PlatformRole;
    user: BackofficeUserSummary;
  }>();
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [notice, setNotice] = useState<string>();
  const pendingRoleCommand = useRef<BackofficeAccessSetRoleCommand>(undefined);
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
        setStatusTarget(undefined);
        setNotice("A conta mudou. A lista foi recarregada; revise o estado atual antes de agir.");
        await resetUsers();
        return;
      }
      if (!isAmbiguousBackofficeError(error)) pendingStatusCommand.current = undefined;
    },
    onSuccess: async (user) => {
      pendingStatusCommand.current = undefined;
      setStatusImpactConfirmed(false);
      setStatusTarget(undefined);
      setNotice(
        user.status === "active"
          ? "Usuário restaurado."
          : "Usuário suspenso e sessões operacionais encerradas.",
      );
      await invalidateUsers();
    },
  });
  const roleMutation = useMutation({
    mutationFn: () => {
      if (pendingRoleCommand.current === undefined) {
        throw new Error("A alteração de papel não possui solicitação idempotente preparada.");
      }
      return executeBackofficeUserCommand(pendingRoleCommand.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isStaleBackofficeError(error)) {
        pendingRoleCommand.current = undefined;
        setNeedsReauthentication(false);
        setRoleTarget(undefined);
        setNotice(
          "Os papéis mudaram. A lista foi recarregada; revise o estado atual antes de agir.",
        );
        await resetUsers();
        return;
      }
      if (!isAmbiguousBackofficeError(error)) pendingRoleCommand.current = undefined;
      if (error instanceof BackofficeClientError && error.code === "REAUTHENTICATION_REQUIRED")
        setNeedsReauthentication(true);
    },
    onSuccess: async () => {
      pendingRoleCommand.current = undefined;
      setRoleTarget(undefined);
      setNotice("Papéis atualizados e sessões incompatíveis revogadas.");
      await invalidateUsers();
    },
  });
  const items = users.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby={`${mode}-title`} className={styles.pageStack}>
      <header>
        <p className={styles.eyebrow}>{mode === "users" ? "Contas" : "Menor privilégio"}</p>
        <h1 id={`${mode}-title`}>{mode === "users" ? "Usuários" : "Acessos"}</h1>
        <p>
          {mode === "users"
            ? "Busque, suspenda ou restaure contas e revele dados somente com motivo auditado."
            : "Conceda e revogue papéis. O banco protege o último administrador ativo."}
        </p>
      </header>
      {needsReauthentication ? (
        <Reauthentication
          session={session}
          onConfirmed={() => {
            setNeedsReauthentication(false);
            setNotice("Identidade confirmada. Revise e confirme a alteração novamente.");
          }}
        />
      ) : null}
      {notice === undefined ? null : <Alert>{notice}</Alert>}
      <form
        className={styles.toolbar}
        onSubmit={async (event) => {
          event.preventDefault();
          const normalized = draftQuery.trim();
          const fingerprint =
            normalized === "" ? "empty" : await backofficeFilterFingerprint(normalized);
          setActiveFilter({ fingerprint, query: normalized });
        }}
      >
        <Field
          description="Prefixo de nome/e-mail ou UUID completo. O filtro não é colocado na URL."
          label="Buscar usuários"
        >
          <Input onChange={(event) => setDraftQuery(event.target.value)} value={draftQuery} />
        </Field>
        <Button type="submit">Buscar</Button>
      </form>
      {users.isPending ? <p role="status">Carregando usuários…</p> : null}
      {users.isError ? <Alert variant="error">{errorMessage(users.error)}</Alert> : null}
      {!users.isPending && !users.isError && items.length === 0 ? (
        <p className={styles.empty}>Nenhum usuário encontrado.</p>
      ) : null}
      <div className={styles.cardGrid}>
        {items.map((user) => (
          <UserCard
            key={user.id}
            mode={mode}
            onRoleChange={(target, role, enabled) => {
              pendingRoleCommand.current = undefined;
              roleMutation.reset();
              setNotice(undefined);
              setRoleTarget({ enabled, role, user: target });
            }}
            onStatusChange={(target) => {
              pendingStatusCommand.current = undefined;
              statusMutation.reset();
              setNotice(undefined);
              setStatusImpactConfirmed(false);
              setStatusTarget(target);
            }}
            session={session}
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
            label="Revisei o impacto desta alteração"
            onChange={(event) => setStatusImpactConfirmed(event.target.checked)}
            required
          />
          {statusMutation.isError ? (
            <Alert variant="error">{errorMessage(statusMutation.error)}</Alert>
          ) : null}
          <div className={styles.actions}>
            <Button
              disabled={!statusImpactConfirmed}
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
              Confirmar
            </Button>
            <Button
              onClick={() => {
                pendingStatusCommand.current = undefined;
                statusMutation.reset();
                setStatusImpactConfirmed(false);
                setStatusTarget(undefined);
              }}
              variant="ghost"
            >
              Cancelar
            </Button>
          </div>
        </section>
      )}
      {roleTarget === undefined ? null : (
        <section aria-labelledby="role-confirmation" className={styles.confirmation}>
          <h2 id="role-confirmation">Confirmar alteração de papel</h2>
          <p>
            {roleTarget.enabled ? "Conceder" : "Revogar"} <strong>{roleTarget.role}</strong> para{" "}
            {roleTarget.user.emailMasked}. Esta ação exige reautenticação recente.
          </p>
          {roleMutation.isError ? (
            <Alert variant="error">{errorMessage(roleMutation.error)}</Alert>
          ) : null}
          <div className={styles.actions}>
            <Button
              loading={roleMutation.isPending}
              loadingLabel="Aplicando"
              onClick={() => {
                pendingRoleCommand.current ??= {
                  action: "backoffice.access.setRole",
                  expectedScope: session.scope,
                  idempotencyKey: crypto.randomUUID(),
                  payload: {
                    enabled: roleTarget.enabled,
                    expectedRoles: roleTarget.user.roles,
                    role: roleTarget.role,
                    userId: roleTarget.user.id,
                  },
                };
                roleMutation.mutate();
              }}
            >
              Confirmar alteração
            </Button>
            <Button
              onClick={() => {
                pendingRoleCommand.current = undefined;
                roleMutation.reset();
                setRoleTarget(undefined);
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
