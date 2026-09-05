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
import { StudioEditorPanels } from "@/domains/studios/components/studio-editor-panels";
import {
  readActiveStudioTaxonomies,
  readActiveStudioTypes,
  readOwnerStudioEditor,
  StudioNotFoundError,
} from "@/domains/studios/server/studio-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description:
    "Edite os dados centrais e o conteúdo comercial do estúdio sem alterar a versão pública.",
  title: "Dados do estúdio",
};

async function readStudioPageData(userId: string, studioId: string) {
  try {
    return await Promise.all([
      readOwnerStudioEditor(userId, studioId),
      readActiveStudioTypes(),
      readActiveStudioTaxonomies(),
    ]);
  } catch (error) {
    if (error instanceof StudioNotFoundError) notFound();
    throw error;
  }
}

export default async function StudioCorePage({
  params,
}: Readonly<{ params: Promise<{ studioId: string }> }>) {
  const { studioId: rawStudioId } = await params;
  const parsedStudioId = z.uuid().safeParse(rawStudioId.toLowerCase());
  if (!parsedStudioId.success) notFound();
  const canonicalPath = `/dono/estudios/${parsedStudioId.data}/dados` as const;
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
      const [editor, studioTypes, taxonomies] = await readStudioPageData(
        session.userId,
        parsedStudioId.data,
      );
      content = (
        <StudioEditorPanels
          initialEditor={editor}
          initialTaxonomies={taxonomies}
          initialTypes={studioTypes}
          userId={session.userId}
        />
      );
    }
  }

  return (
    <OwnerPageFrame
      currentPage="studio-editor"
      description="Salve explicitamente um rascunho. Se já houver publicação, ela permanece intacta até uma futura aprovação."
      title="Dados do estúdio"
    >
      {content}
    </OwnerPageFrame>
  );
}
