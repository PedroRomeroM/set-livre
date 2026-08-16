import { Alert, Stack } from "@set-livre/ui";
import Link from "next/link";

import { OwnerPageFrame } from "@/domains/owners/components/owner-page-frame";
import styles from "@/domains/studios/components/studio.module.css";

export default function StudioDataNotFound() {
  return (
    <OwnerPageFrame
      currentPage="studio"
      description="O editor solicitado não está disponível para esta conta."
      title="Estúdio não encontrado"
    >
      <Stack space={4}>
        <Alert title="Não foi possível abrir este estúdio" variant="error">
          O estúdio não existe ou não pertence à conta autenticada.
        </Alert>
        <div className={styles.actions}>
          <Link className={styles.textLink} href={{ pathname: "/dono/estudios/novo" }}>
            Cadastrar outro estúdio
          </Link>
        </div>
      </Stack>
    </OwnerPageFrame>
  );
}
