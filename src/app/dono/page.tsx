import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";
import {
  OwnerProfileRequiredState,
  OwnerSuspendedState,
} from "@/domains/owners/components/owner-access-state";
import { OwnerPageFrame } from "@/domains/owners/components/owner-page-frame";
import { OwnerRecipientPanel } from "@/domains/owners/components/owner-recipient-panel";
import { readOwnerRecipient } from "@/domains/owners/server/owner-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Ative seu perfil de dono e acompanhe as etapas necessárias para receber reservas.",
  title: "Ativação como dono",
};

export default async function OwnerPage() {
  const session = await readComponentIdentitySession();
  if (!session.authenticated) {
    redirect("/entrar?retorno=%2Fdono");
  }

  return (
    <OwnerPageFrame
      currentPage="overview"
      description="Aceite o contrato do dono e acompanhe, sem antecipar integrações externas, as etapas que liberam reservas."
      title="Ativação como dono"
    >
      {session.status === "suspended" ? (
        <OwnerSuspendedState />
      ) : !session.profileCompleted ? (
        <OwnerProfileRequiredState />
      ) : (
        <OwnerRecipientPanel
          initialResult={await readOwnerRecipient(session.userId)}
          userId={session.userId}
          view="overview"
        />
      )}
    </OwnerPageFrame>
  );
}
