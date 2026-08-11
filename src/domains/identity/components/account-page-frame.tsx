import { PageFrame, Panel } from "@set-livre/ui";
import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./account.module.css";

type AccountPage = "profile" | "security";

export function AccountPageFrame({
  children,
  currentPage,
  description,
  title,
}: Readonly<{
  children: ReactNode;
  currentPage: AccountPage;
  description: ReactNode;
  title: ReactNode;
}>) {
  return (
    <PageFrame width="wide">
      <div className={styles.accountShell}>
        <header className={styles.accountHeader}>
          <p className={styles.eyebrow}>Conta Set Livre</p>
          <h1 className={styles.pageTitle}>{title}</h1>
          <p className={styles.pageDescription}>{description}</p>
        </header>

        <div className={styles.accountLayout}>
          <nav aria-label="Configurações da conta" className={styles.accountNav}>
            <Link
              aria-current={currentPage === "profile" ? "page" : undefined}
              className={styles.accountNavLink}
              href="/conta"
            >
              Perfil e aparência
            </Link>
            <Link
              aria-current={currentPage === "security" ? "page" : undefined}
              className={styles.accountNavLink}
              href="/conta/seguranca"
            >
              Segurança
            </Link>
          </nav>
          <Panel className={styles.accountContent}>{children}</Panel>
        </div>
      </div>
    </PageFrame>
  );
}
