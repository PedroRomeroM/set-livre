import { AuthFrame } from "@set-livre/ui";
import type { Metadata } from "next";

import { RegistrationForm } from "@/domains/identity/components/registration-form";
import { readCurrentLegalDocuments } from "@/domains/identity/server/identity-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Crie uma conta Set Livre com aceite dos documentos legais vigentes.",
  title: "Criar conta",
};

export default async function RegistrationPage() {
  const legalDocuments = await readCurrentLegalDocuments();

  return (
    <AuthFrame
      description="Crie seu acesso por e-mail e confirme a mensagem enviada para ativar a conta."
      eyebrow="Acesso seguro"
      title="Crie sua conta"
    >
      <RegistrationForm legalDocuments={legalDocuments} />
    </AuthFrame>
  );
}
