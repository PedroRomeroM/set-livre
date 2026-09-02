import { PageFrame, Panel } from "@set-livre/ui";
import type { ReactNode } from "react";

import styles from "./owner.module.css";

export type OwnerPage = "overview" | "recipient" | "studio-create" | "studio-editor";

export function OwnerPageFrame({
  children,
  currentPage,
  description,
  title,
}: Readonly<{
  children: ReactNode;
  currentPage: OwnerPage;
  description: ReactNode;
  title: ReactNode;
}>) {
  return (
    <PageFrame aria-labelledby="owner-page-title" width="wide">
      <div className={styles.ownerShell}>
        <header className={styles.ownerHeader}>
          <p className={styles.eyebrow}>Área do dono</p>
          <h1 className={styles.pageTitle} id="owner-page-title">
            {title}
          </h1>
          <p className={styles.pageDescription}>{description}</p>
        </header>

        <div className={styles.ownerLayout}>
          <nav aria-label="Área do dono" className={styles.ownerNav}>
            <a
              aria-current={currentPage === "overview" ? "page" : undefined}
              className={styles.ownerNavLink}
              href="/dono"
            >
              Ativação
            </a>
            <a
              aria-current={currentPage === "recipient" ? "page" : undefined}
              className={styles.ownerNavLink}
              href="/dono/recebimentos"
            >
              Recebimentos
            </a>
            <a
              aria-current={currentPage === "studio-create" ? "page" : undefined}
              className={styles.ownerNavLink}
              href="/dono/estudios/novo"
            >
              Novo estúdio
            </a>
          </nav>
          <Panel className={styles.ownerContent}>{children}</Panel>
        </div>
      </div>
    </PageFrame>
  );
}
