import { backofficeUserSummarySchema } from "@set-livre/contracts";
import { Alert, ButtonLink } from "@set-livre/ui";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import {
  AccessRoleActions,
  type BackofficeAccessTransition,
} from "@/domains/backoffice/components/access-role-actions";
import { backofficeLandingPath } from "@/domains/backoffice/backoffice-authorization";
import styles from "@/domains/backoffice/components/backoffice.module.css";
import { readBackofficeUserAccess } from "@/domains/backoffice/server/backoffice-service";
import {
  readComponentBackofficeState,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";
import { BackofficeApiError } from "@/lib/server/api-route";

function accessTransitions(
  roles: readonly string[],
  grantsAllowed: boolean,
): readonly BackofficeAccessTransition[] {
  return [
    roles.includes("support")
      ? {
          action: "backoffice.access.revokeSupport",
          buttonLabel: "Revisar revogação de suporte",
          confirmation: "Revogar o acesso de suporte desta conta.",
        }
      : grantsAllowed
        ? {
            action: "backoffice.access.grantSupport",
            buttonLabel: "Revisar concessão de suporte",
            confirmation: "Conceder acesso de suporte a esta conta.",
          }
        : undefined,
    roles.includes("admin")
      ? {
          action: "backoffice.access.revokeAdmin",
          buttonLabel: "Revisar revogação administrativa",
          confirmation: "Revogar o acesso administrativo desta conta.",
        }
      : grantsAllowed
        ? {
            action: "backoffice.access.grantAdmin",
            buttonLabel: "Revisar concessão administrativa",
            confirmation: "Conceder acesso administrativo a esta conta.",
          }
        : undefined,
    roles.includes("reviewer")
      ? {
          action: "backoffice.access.revokeReviewer",
          buttonLabel: "Revisar revogação de revisão",
          confirmation: "Revogar o acesso à revisão editorial de estúdios desta conta.",
        }
      : grantsAllowed
        ? {
            action: "backoffice.access.grantReviewer",
            buttonLabel: "Revisar concessão de revisão",
            confirmation: "Conceder acesso à revisão editorial de estúdios desta conta.",
          }
        : undefined,
  ].filter((transition): transition is BackofficeAccessTransition => transition !== undefined);
}

function grantRestriction(status: "active" | "suspended", profileCompleted: boolean) {
  if (status === "active" && profileCompleted) return undefined;
  if (status === "suspended" && !profileCompleted) {
    return "A conta está suspensa e o perfil está incompleto. Restaure a conta e conclua o perfil antes de conceder novos acessos.";
  }
  return status === "suspended"
    ? "A conta está suspensa. Restaure-a antes de conceder novos acessos."
    : "O perfil está incompleto. A conta precisa concluir o perfil antes de receber novos acessos.";
}

export default async function BackofficeAccessDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const state = await readComponentBackofficeState();
  if (state === undefined) return null;
  if (!state.session.roles.includes("admin")) {
    redirect(backofficeLandingPath(state.session.roles));
  }
  const parsedUserId = z.uuid().safeParse((await params).userId);
  if (!parsedUserId.success) notFound();
  let access;
  try {
    access = await readBackofficeUserAccess({ auth: state.auth, userId: parsedUserId.data });
  } catch (error) {
    if (error instanceof BackofficeApiError && error.status === 404) notFound();
    throw error;
  }
  const user = backofficeUserSummarySchema.parse({
    accountVersion: access.account_version,
    createdAt: access.created_at,
    emailMasked: access.email_masked,
    id: access.id,
    status: access.status,
  });
  const browserSession = await toBrowserBackofficeSession(state.session);
  if (!browserSession.authenticated) return null;
  const restriction = grantRestriction(user.status, access.profile_completed);
  const transitions = accessTransitions(access.roles, restriction === undefined);

  return (
    <section aria-labelledby="access-detail-title" className={styles.pageStack}>
      <header>
        <p className={styles.eyebrow}>Menor privilégio</p>
        <h1 id="access-detail-title">Acessos da conta {user.emailMasked}</h1>
        <p>
          O estado abaixo foi composto no servidor. Cada alteração é revalidada no banco contra a
          versão {user.accountVersion}.
        </p>
      </header>
      <article className={styles.card}>
        <h2>Estado atual</h2>
        <dl className={styles.definitionList}>
          <dt>Suporte</dt>
          <dd>{access.roles.includes("support") ? "Concedido" : "Não concedido"}</dd>
          <dt>Administração</dt>
          <dd>{access.roles.includes("admin") ? "Concedido" : "Não concedido"}</dd>
          <dt>Revisão editorial</dt>
          <dd>{access.roles.includes("reviewer") ? "Concedido" : "Não concedido"}</dd>
          <dt>Conta</dt>
          <dd>{user.status === "active" ? "Ativa" : "Suspensa"}</dd>
          <dt>Perfil</dt>
          <dd>{access.profile_completed ? "Completo" : "Incompleto"}</dd>
        </dl>
      </article>
      {restriction === undefined ? null : (
        <Alert title="Novas concessões indisponíveis" variant="status">
          {restriction}{" "}
          {access.roles.length === 0
            ? "Não há acessos concedidos para revogar."
            : "Os acessos já concedidos ainda podem ser revogados."}
        </Alert>
      )}
      {transitions.length === 0 ? null : (
        <AccessRoleActions session={browserSession} transitions={transitions} user={user} />
      )}
      <div>
        <ButtonLink href="/acessos" variant="ghost">
          Voltar à busca de acessos
        </ButtonLink>
      </div>
    </section>
  );
}
