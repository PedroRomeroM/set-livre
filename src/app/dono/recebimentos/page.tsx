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
  description: "Consulte o estado seguro e os próximos passos do cadastro de recebimentos.",
  title: "Cadastro de recebimentos",
};

export default async function OwnerRecipientPage() {
  const session = await readComponentIdentitySession();
  if (!session.authenticated) {
    redirect("/entrar?retorno=%2Fdono%2Frecebimentos");
  }

  return (
    <OwnerPageFrame
      currentPage="recipient"
      description="Consulte estados internos e próximos passos seguros do cadastro local de recebimentos."
      title="Cadastro de recebimentos"
    >
      {session.status === "suspended" ? (
        <OwnerSuspendedState />
      ) : !session.profileCompleted ? (
        <OwnerProfileRequiredState />
      ) : (
        <OwnerRecipientPanel
          initialResult={await readOwnerRecipient(session.userId)}
          userId={session.userId}
          view="recipient"
        />
      )}
    </OwnerPageFrame>
  );
}
