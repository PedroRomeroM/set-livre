import { AuthFrame } from "@set-livre/ui";
import type { Metadata } from "next";

import { RecoveryFlow } from "@/domains/identity/components/recovery-flow";
import { readRecoverySessionScope } from "@/domains/identity/server/recovery-grant";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Solicite um link seguro ou defina uma nova senha para sua conta Set Livre.",
  title: "Recuperar senha",
};

export default async function PasswordRecoveryPage() {
  const initialSessionScope = await readRecoverySessionScope();

  return (
    <AuthFrame
      description="O link recebido por e-mail é validado antes de liberar a definição de uma nova senha."
      eyebrow="Recuperação segura"
      title="Recupere seu acesso"
    >
      <RecoveryFlow initialSessionScope={initialSessionScope} />
    </AuthFrame>
  );
}
