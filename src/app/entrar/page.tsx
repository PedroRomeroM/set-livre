import { AuthFrame } from "@set-livre/ui";
import type { Metadata } from "next";

import { LoginPanel } from "@/domains/identity/components/login-panel";
import { resolveAccountLoginReturnTarget } from "@/domains/identity/components/login-session-transition";
import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Entre com sua conta Set Livre ou encerre uma sessão ativa.",
  title: "Entrar",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    entrada?: string | string[] | undefined;
    retorno?: string | string[] | undefined;
    saida?: string | string[] | undefined;
  }>;
}) {
  const query = await searchParams;
  const initialSession = await readComponentIdentitySession();
  const returnTo = resolveAccountLoginReturnTarget(query.retorno);

  return (
    <AuthFrame
      description="Sua sessão é validada no servidor antes de qualquer acesso privado."
      eyebrow="Set Livre"
      title="Entre na sua conta"
    >
      <LoginPanel
        initialSession={initialSession}
        loginNeedsVerification={query.entrada === "verificar"}
        logoutNeedsVerification={query.saida === "verificar"}
        returnTo={returnTo}
      />
    </AuthFrame>
  );
}
