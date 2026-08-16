import { Alert, Stack } from "@set-livre/ui";
import Link from "next/link";

import styles from "./owner.module.css";

export function OwnerSuspendedState() {
  return (
    <Alert title="Conta suspensa" variant="error">
      A ativação e o cadastro de recebimentos estão indisponíveis enquanto a conta estiver suspensa.
      Nenhum dado pode ser enviado nesta página.
    </Alert>
  );
}

export function OwnerProfileRequiredState() {
  return (
    <Stack space={4}>
      <Alert title="Complete seu perfil primeiro">
        A ativação como dono usa os dados validados do seu perfil. Conclua essa etapa antes de
        aceitar o contrato do dono.
      </Alert>
      <div className={styles.actions}>
        <Link className={styles.textLink} href="/conta">
          Completar perfil
        </Link>
      </div>
    </Stack>
  );
}
