import { Alert, Stack } from "@set-livre/ui";
import Link from "next/link";

import { OwnerPageFrame } from "@/domains/owners/components/owner-page-frame";
import styles from "@/domains/owners/components/owner.module.css";

export default function StudioNotFound() {
  return (
    <OwnerPageFrame
      currentPage="studio-editor"
      description="O endereço informado não corresponde a um estúdio acessível pela sessão atual."
      title="Estúdio não encontrado"
    >
      <Stack space={4}>
        <Alert title="Não foi possível abrir este estúdio" variant="error">
          Ele pode ter sido removido ou pertencer a outra conta. Nenhum dado privado foi exibido.
        </Alert>
        <div className={styles.actions}>
          <Link className={styles.textLink} href="/dono/estudios/novo">
            Criar outro estúdio
          </Link>
        </div>
      </Stack>
    </OwnerPageFrame>
  );
}
