import type { PlatformRole } from "@set-livre/contracts";
import Link from "next/link";

import styles from "./backoffice.module.css";

export function BackofficeNavigation({ roles }: Readonly<{ roles: readonly PlatformRole[] }>) {
  const isAdmin = roles.includes("admin");
  return (
    <nav aria-label="Backoffice" className={styles.navigation}>
      <Link href="/usuarios">Usuários</Link>
      {isAdmin ? <Link href="/taxonomias">Taxonomias</Link> : null}
      {isAdmin ? <Link href="/acessos">Acessos</Link> : null}
    </nav>
  );
}
