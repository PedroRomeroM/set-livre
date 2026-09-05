import { Alert, Stack } from "@set-livre/ui";
import Link from "next/link";

import styles from "@/domains/owners/components/owner.module.css";

export function StudioSuspendedState() {
  return (
    <Alert title="Conta suspensa" variant="error">
      O gerenciamento de estúdios fica indisponível enquanto a conta estiver suspensa.
    </Alert>
  );
}

export function StudioOwnerActivationRequiredState() {
  return (
    <Stack space={4}>
      <Alert title="Ative seu cadastro de dono">
        O estúdio precisa estar vinculado a uma autoridade de dono ativa e ao contrato vigente.
      </Alert>
      <div className={styles.actions}>
        <Link className={styles.textLink} href="/dono">
          Ir para ativação
        </Link>
      </div>
    </Stack>
  );
}
