import { AuthFrame } from "@set-livre/ui";
import type { Metadata } from "next";

import { AuthCallbackPanel } from "@/domains/identity/components/auth-callback-panel";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Validar acesso",
};

export default function AuthCallbackPage() {
  return (
    <AuthFrame
      description="A validação ocorre uma única vez e o token é removido do endereço antes do envio."
      eyebrow="Confirmação segura"
      title="Validando seu acesso"
    >
      <AuthCallbackPanel />
    </AuthFrame>
  );
}
