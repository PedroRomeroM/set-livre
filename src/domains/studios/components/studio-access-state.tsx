import { Alert, Stack } from "@set-livre/ui";
import Link from "next/link";

import styles from "./studio.module.css";

export function StudioSuspendedState() {
  return (
    <Alert title="Conta suspensa" variant="error">
      O cadastro e a edição de estúdios ficam indisponíveis enquanto a conta estiver suspensa.
      Nenhum dado pode ser enviado nesta página.
    </Alert>
  );
}

export function StudioProfileRequiredState() {
  return (
    <Stack space={4}>
      <Alert title="Complete seu perfil primeiro">
        O cadastro do estúdio usa a identidade validada do seu perfil. Conclua essa etapa antes de
        criar ou editar um rascunho.
      </Alert>
      <div className={styles.actions}>
        <Link className={styles.textLink} href="/conta">
          Completar perfil
        </Link>
      </div>
    </Stack>
  );
}

export function StudioOwnerActivationRequiredState() {
  return (
    <Stack space={4}>
      <Alert title="Ative seu cadastro de dono">
        Somente um cadastro de dono ativo pode criar ou editar estúdios. Conclua a ativação antes de
        abrir o editor.
      </Alert>
      <div className={styles.actions}>
        <Link className={styles.textLink} href="/dono">
          Ir para ativação
        </Link>
      </div>
    </Stack>
  );
}
