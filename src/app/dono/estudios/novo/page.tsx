import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";
import { OwnerProfileRequiredState } from "@/domains/owners/components/owner-access-state";
import { OwnerPageFrame } from "@/domains/owners/components/owner-page-frame";
import { readOwnerActivation } from "@/domains/owners/server/owner-read-model";
import {
  StudioOwnerActivationRequiredState,
  StudioSuspendedState,
} from "@/domains/studios/components/studio-access-state";
import { StudioCorePanel } from "@/domains/studios/components/studio-core-panel";
import { readActiveStudioTypes } from "@/domains/studios/server/studio-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Crie um estúdio privado e salve seus dados centrais em uma revisão segura.",
  title: "Novo estúdio",
};

export default async function NewStudioPage() {
  const session = await readComponentIdentitySession();
  if (!session.authenticated) {
    redirect("/entrar?retorno=%2Fdono%2Festudios%2Fnovo");
  }

  let content;
  if (session.status === "suspended") {
    content = <StudioSuspendedState />;
  } else if (!session.profileCompleted) {
    content = <OwnerProfileRequiredState />;
  } else {
    const [owner, studioTypes] = await Promise.all([
      readOwnerActivation(session.userId),
      readActiveStudioTypes(),
    ]);
    content =
      owner.ownerStatus !== "active" || !owner.ownerContractAccepted ? (
        <StudioOwnerActivationRequiredState />
      ) : (
        <StudioCorePanel initialTypes={studioTypes} mode="create" userId={session.userId} />
      );
  }

  return (
    <OwnerPageFrame
      currentPage="studio"
      description="Cadastre o conteúdo central em um rascunho privado. Nada será publicado nesta etapa."
      title="Novo estúdio"
    >
      {content}
    </OwnerPageFrame>
  );
}
