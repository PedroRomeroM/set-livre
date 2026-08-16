import { ownerStudioEditorQuerySchema } from "@set-livre/contracts";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

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
import { ApiRouteError } from "@/lib/server/api-route";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Edite e compare o rascunho dos dados centrais de um estúdio.",
  title: "Dados do estúdio",
};

async function readExistingStudioEditor(userId: string, studioId: string) {
  try {
    return await readOwnerStudioEditor(userId, studioId);
  } catch (error) {
    if (error instanceof ApiRouteError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

async function ActiveOwnerStudioEditor({
  studioId,
  userId,
}: Readonly<{ studioId: string; userId: string }>) {
  const owner = await readOwnerRecipient(userId);
  if (owner.ownerStatus !== "active") return <StudioOwnerActivationRequiredState />;
  return (
    <StudioEditorPanel
      initialResult={await readExistingStudioEditor(userId, studioId)}
      studioId={studioId}
      userId={userId}
    />
  );
}

export default async function StudioDataPage({
  params,
}: Readonly<{ params: Promise<{ studioId: string }> }>) {
  const session = await readComponentIdentitySession();
  const { studioId: rawStudioId } = await params;
  const parsedQuery = ownerStudioEditorQuerySchema.safeParse({ studioId: rawStudioId });
  if (!parsedQuery.success || parsedQuery.data.studioId === undefined) notFound();
  const studioId = parsedQuery.data.studioId;

  if (!session.authenticated) {
    redirect(`/entrar?retorno=${encodeURIComponent(`/dono/estudios/${studioId}/dados`)}`);
  }

  return (
    <OwnerPageFrame
      currentPage="studio"
      description="Edite o rascunho sem alterar a versão aprovada. Compare o estado atual antes de recuperar um conflito."
      title="Dados do estúdio"
    >
      {session.status === "suspended" ? (
        <StudioSuspendedState />
      ) : !session.profileCompleted ? (
        <StudioProfileRequiredState />
      ) : (
        <ActiveOwnerStudioEditor studioId={studioId} userId={session.userId} />
      )}
    </OwnerPageFrame>
  );
}
