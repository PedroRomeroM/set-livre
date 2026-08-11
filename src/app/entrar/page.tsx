import { AuthFrame } from "@set-livre/ui";
import type { Metadata } from "next";

import { LoginPanel } from "@/domains/identity/components/login-panel";
import { readComponentIdentitySession } from "@/domains/identity/server/identity-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Entre com sua conta Set Livre ou encerre uma sessão ativa.",
  title: "Entrar",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ saida?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const initialSession = await readComponentIdentitySession();

  return (
    <AuthFrame
      description="Sua sessão é validada no servidor antes de qualquer acesso privado."
      eyebrow="Set Livre"
      title="Entre na sua conta"
    >
      <LoginPanel
        initialSession={initialSession}
        logoutNeedsVerification={query.saida === "verificar"}
      />
    </AuthFrame>
  );
}
