import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";
import { OwnerPageFrame } from "@/domains/owners/components/owner-page-frame";
import { readOwnerRecipient } from "@/domains/owners/server/owner-read-model";
import {
  StudioOwnerActivationRequiredState,
  StudioProfileRequiredState,
  StudioSuspendedState,
} from "@/domains/studios/components/studio-access-state";
import { StudioEditorPanel } from "@/domains/studios/components/studio-editor-panel";
import { readOwnerStudioEditor } from "@/domains/studios/server/studio-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Crie o rascunho inicial com os dados centrais de um estúdio.",
  title: "Cadastrar estúdio",
};

async function ActiveOwnerNewStudioEditor({ userId }: Readonly<{ userId: string }>) {
  const owner = await readOwnerRecipient(userId);
  if (owner.ownerStatus !== "active") return <StudioOwnerActivationRequiredState />;
  return <StudioEditorPanel initialResult={await readOwnerStudioEditor(userId)} userId={userId} />;
}

export default async function NewStudioPage() {
  const session = await readComponentIdentitySession();
  if (!session.authenticated) {
    redirect("/entrar?retorno=%2Fdono%2Festudios%2Fnovo");
  }

  return (
    <OwnerPageFrame
      currentPage="studio"
      description="Preencha os dados centrais e salve explicitamente o primeiro rascunho. Nada será publicado nesta etapa."
      title="Cadastrar estúdio"
    >
      {session.status === "suspended" ? (
        <StudioSuspendedState />
      ) : !session.profileCompleted ? (
        <StudioProfileRequiredState />
      ) : (
        <ActiveOwnerNewStudioEditor userId={session.userId} />
      )}
    </OwnerPageFrame>
  );
}
