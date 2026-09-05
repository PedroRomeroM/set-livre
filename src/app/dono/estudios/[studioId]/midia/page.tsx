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
import { StudioMediaPanel } from "@/domains/studios/components/studio-media-panel";
import {
  readOwnerStudioEditor,
  StudioNotFoundError,
} from "@/domains/studios/server/studio-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Gerencie as fotos privadas do rascunho do estúdio.",
  title: "Fotos do estúdio",
};

async function assertStudioOwnership(userId: string, studioId: string) {
  try {
    await readOwnerStudioEditor(userId, studioId);
  } catch (error) {
    if (error instanceof StudioNotFoundError) notFound();
    throw error;
  }
}

export default async function StudioMediaPage({
  params,
}: Readonly<{ params: Promise<{ studioId: string }> }>) {
  const { studioId: rawStudioId } = await params;
  const parsedStudioId = z.uuid().safeParse(rawStudioId.toLowerCase());
  if (!parsedStudioId.success) notFound();
  const canonicalPath = `/dono/estudios/${parsedStudioId.data}/midia` as const;
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
      await assertStudioOwnership(session.userId, parsedStudioId.data);
      content = <StudioMediaPanel studioId={parsedStudioId.data} userId={session.userId} />;
    }
  }

  return (
    <OwnerPageFrame
      currentPage="studio-editor"
      description="Envie e organize as fotos do rascunho. Esta galeria é privada e não publica alterações."
      title="Fotos do estúdio"
    >
      {content}
    </OwnerPageFrame>
  );
}
