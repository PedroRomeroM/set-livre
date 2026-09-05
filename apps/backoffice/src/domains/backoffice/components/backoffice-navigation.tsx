import type { PlatformRole } from "@set-livre/contracts";
import Link from "next/link";

import { canManageBackofficeUsers, canReviewBackofficeStudios } from "../backoffice-authorization";
import styles from "./backoffice.module.css";

export function BackofficeNavigation({ roles }: Readonly<{ roles: readonly PlatformRole[] }>) {
  const isAdmin = roles.includes("admin");
  return (
    <nav aria-label="Backoffice" className={styles.navigation}>
      {canManageBackofficeUsers(roles) ? <Link href="/usuarios">Usuários</Link> : null}
      {canReviewBackofficeStudios(roles) ? <Link href="/estudios">Estúdios</Link> : null}
      {isAdmin ? <Link href="/taxonomias">Taxonomias</Link> : null}
      {isAdmin ? <Link href="/acessos">Acessos</Link> : null}
    </nav>
  );
}
