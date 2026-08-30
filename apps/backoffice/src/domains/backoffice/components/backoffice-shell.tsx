"use client";

import type { BackofficeSession } from "@set-livre/contracts";
import { Button } from "@set-livre/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { logoutBackofficeClient } from "./backoffice-api";
import styles from "./backoffice.module.css";

type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;

const navigation = [
  { adminOnly: false, href: "/usuarios", label: "Usuários" },
  { adminOnly: true, href: "/taxonomias", label: "Taxonomias" },
  { adminOnly: true, href: "/acessos", label: "Acessos" },
] as const;

export function BackofficeShell({
  children,
  session,
}: Readonly<{ children: ReactNode; session: AuthenticatedSession }>) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => logoutBackofficeClient(session.scope),
    onSuccess: () => {
      queryClient.clear();
      router.replace("/entrar?saida=sucesso");
      router.refresh();
    },
  });

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#conteudo-principal">
        Ir para o conteúdo
      </a>
      <header className={styles.header}>
        <div>
          <p className={styles.brand}>Set Livre</p>
          <p className={styles.environment}>Backoffice operacional</p>
        </div>
        <div className={styles.sessionSummary}>
          <span>{session.email}</span>
          <span>{session.roles.join(" + ")}</span>
          <Button
            loading={logout.isPending}
            loadingLabel="Saindo"
            onClick={() => logout.mutate()}
            variant="ghost"
          >
            Sair
          </Button>
        </div>
      </header>
      <nav aria-label="Backoffice" className={styles.navigation}>
        {navigation
          .filter((item) => !item.adminOnly || session.roles.includes("admin"))
          .map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link aria-current={active ? "page" : undefined} href={item.href} key={item.href}>
                {item.label}
              </Link>
            );
          })}
      </nav>
      {logout.isError ? (
        <p className={styles.globalError} role="alert">
          Não foi possível encerrar a sessão. Tente novamente.
        </p>
      ) : null}
      <main className={styles.main} id="conteudo-principal">
        {children}
      </main>
    </div>
  );
}
