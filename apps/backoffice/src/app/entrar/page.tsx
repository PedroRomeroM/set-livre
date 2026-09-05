import { AuthFrame } from "@set-livre/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BackofficeLoginForm } from "@/domains/backoffice/components/login-form";
import { readComponentBackofficeSession } from "@/domains/backoffice/server/backoffice-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Acesso autenticado à operação Set Livre.",
  title: "Entrar · Backoffice",
};

export default async function BackofficeLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ saida?: string | string[] | undefined }>;
}) {
  const session = await readComponentBackofficeSession();
  if (session.authenticated) redirect("/");
  const query = await searchParams;
  return (
    <AuthFrame
      description="Acesso restrito a operadores autorizados. Sessão, perfil e papel são revalidados no servidor."
      eyebrow="Set Livre"
      title="Operação Set Livre"
    >
      <BackofficeLoginForm signedOut={query.saida === "sucesso"} />
    </AuthFrame>
  );
}
