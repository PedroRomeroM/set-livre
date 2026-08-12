import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountPageFrame } from "@/domains/identity/components/account-page-frame";
import { AccountProfilePanel } from "@/domains/identity/components/account-profile-panel";
import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";
import { readOwnProfile } from "@/domains/identity/server/profile-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Gerencie seu perfil PF ou PJ e a aparência da conta Set Livre.",
  title: "Minha conta",
};

export default async function AccountPage() {
  const session = await readComponentIdentitySession();
  if (!session.authenticated) {
    redirect("/entrar?retorno=%2Fconta");
  }
  const initialProfile = await readOwnProfile(session.userId);

  return (
    <AccountPageFrame
      currentPage="profile"
      description="Revise os dados do titular, documentos mascarados e a preferência visual."
      title="Minha conta"
    >
      <AccountProfilePanel initialProfile={initialProfile} userId={session.userId} />
    </AccountPageFrame>
  );
}
