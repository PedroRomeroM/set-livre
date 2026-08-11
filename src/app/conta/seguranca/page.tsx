import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountPageFrame } from "@/domains/identity/components/account-page-frame";
import { AccountSecurityPanel } from "@/domains/identity/components/account-security-panel";
import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Consulte o e-mail autenticado, recupere a senha ou encerre a sessão.",
  title: "Segurança da conta",
};

export default async function AccountSecurityPage() {
  const session = await readComponentIdentitySession();
  if (!session.authenticated) {
    redirect("/entrar?retorno=%2Fconta%2Fseguranca");
  }

  return (
    <AccountPageFrame
      currentPage="security"
      description="O e-mail continua sob o Auth; senha e logout usam os fluxos seguros existentes."
      title="Segurança da conta"
    >
      <AccountSecurityPanel initialSession={session} />
    </AccountPageFrame>
  );
}
