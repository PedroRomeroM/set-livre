import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";
import { OwnerProfileRequiredState } from "@/domains/owners/components/owner-access-state";
import { OwnerPageFrame } from "@/domains/owners/components/owner-page-frame";
import { readOwnerActivation } from "@/domains/owners/server/owner-read-model";
import {
  StudioOwnerActivationRequiredState,
  StudioSuspendedState,
} from "@/domains/studios/components/studio-access-state";
import { StudioPublicationPanel } from "@/domains/studios/components/studio-publication-panel";
import {
  readOwnerStudioPublication,
  StudioPublicationNotFoundError,
} from "@/domains/studios/server/studio-publication-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Revise o anúncio, acompanhe seu estado editorial e gerencie sua disponibilidade.",
  title: "Publicação do estúdio",
};

async function readStudioPublicationPageData(userId: string, studioId: string) {
  try {
    return await readOwnerStudioPublication(userId, studioId);
  } catch (error) {
    if (error instanceof StudioPublicationNotFoundError) notFound();
    throw error;
  }
}

export default async function StudioPublicationPage({
  params,
}: Readonly<{ params: Promise<{ studioId: string }> }>) {
  const { studioId: rawStudioId } = await params;
  const parsedStudioId = z.uuid().safeParse(rawStudioId.toLowerCase());
  if (!parsedStudioId.success) notFound();
  const canonicalPath = `/dono/estudios/${parsedStudioId.data}/publicacao` as const;
  if (rawStudioId !== parsedStudioId.data) redirect(canonicalPath);

  const session = await readComponentIdentitySession();
  if (!session.authenticated) {
    redirect(`/entrar?retorno=${encodeURIComponent(canonicalPath)}`);
  }

  let content;
  if (session.status === "suspended") {
    content = <StudioSuspendedState />;
  } else if (!session.profileCompleted) {
    content = <OwnerProfileRequiredState />;
  } else {
    const owner = await readOwnerActivation(session.userId);
    if (owner.ownerStatus !== "active" || !owner.ownerContractAccepted) {
      content = <StudioOwnerActivationRequiredState />;
    } else {
      const publication = await readStudioPublicationPageData(session.userId, parsedStudioId.data);
      content = <StudioPublicationPanel initialPublication={publication} userId={session.userId} />;
    }
  }

  return (
    <OwnerPageFrame
      currentPage="studio-editor"
      description="Confira os fatos do anúncio antes do envio. Aprovação e rejeição pertencem à revisão da equipe Set Livre."
      title="Publicação do estúdio"
    >
      {content}
    </OwnerPageFrame>
  );
}
