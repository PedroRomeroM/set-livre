import { backofficeUserSummarySchema } from "@set-livre/contracts";
import { ButtonLink } from "@set-livre/ui";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import {
  AccessRoleActions,
  type BackofficeAccessTransition,
} from "@/domains/backoffice/components/access-role-actions";
import styles from "@/domains/backoffice/components/backoffice.module.css";
import { readBackofficeUserAccess } from "@/domains/backoffice/server/backoffice-service";
import {
  readComponentBackofficeState,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";

function accessTransitions(roles: readonly string[]): readonly BackofficeAccessTransition[] {
  return [
    roles.includes("support")
      ? {
          action: "backoffice.access.revokeSupport",
          buttonLabel: "Revisar revogação de suporte",
          confirmation: "Revogar o acesso de suporte desta conta.",
        }
      : {
          action: "backoffice.access.grantSupport",
          buttonLabel: "Revisar concessão de suporte",
          confirmation: "Conceder acesso de suporte a esta conta.",
        },
    roles.includes("admin")
      ? {
          action: "backoffice.access.revokeAdmin",
          buttonLabel: "Revisar revogação administrativa",
          confirmation: "Revogar o acesso administrativo desta conta.",
        }
      : {
          action: "backoffice.access.grantAdmin",
          buttonLabel: "Revisar concessão administrativa",
          confirmation: "Conceder acesso administrativo a esta conta.",
        },
  ];
}

export default async function BackofficeAccessDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const state = await readComponentBackofficeState();
  if (state === undefined) return null;
  if (!state.session.roles.includes("admin")) redirect("/usuarios");
  const parsedUserId = z.uuid().safeParse((await params).userId);
  if (!parsedUserId.success) notFound();
  const access = await readBackofficeUserAccess({ auth: state.auth, userId: parsedUserId.data });
  const user = backofficeUserSummarySchema.parse({
    accountVersion: access.account_version,
    createdAt: access.created_at,
    emailMasked: access.email_masked,
    id: access.id,
    status: access.status,
  });
  const browserSession = await toBrowserBackofficeSession(state.session);
  if (!browserSession.authenticated) return null;

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
          <dt>Conta</dt>
          <dd>{user.status === "active" ? "Ativa" : "Suspensa"}</dd>
        </dl>
      </article>
      <AccessRoleActions
        session={browserSession}
        transitions={accessTransitions(access.roles)}
        user={user}
      />
      <div>
        <ButtonLink href="/acessos" variant="ghost">
          Voltar à busca de acessos
        </ButtonLink>
      </div>
    </section>
  );
}
