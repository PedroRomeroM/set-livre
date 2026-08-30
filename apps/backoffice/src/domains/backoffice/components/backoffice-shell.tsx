"use client";

import type { BackofficeSession } from "@set-livre/contracts";
import { Button } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import { logoutBackofficeClient, readBackofficeSessionClient } from "./backoffice-api";
import styles from "./backoffice.module.css";
import { backofficeQueryKeys } from "./query-keys";
import {
  notifyBackofficeSessionChanged,
  subscribeToBackofficeSessionChanges,
} from "./session-events";

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
  const intentionalLogout = useRef(false);
  const currentSession = useQuery({
    initialData: session,
    initialDataUpdatedAt: 0,
    queryFn: readBackofficeSessionClient,
    queryKey: backofficeQueryKeys.session(session.scope),
    refetchInterval: 15_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 0,
  });
  const {
    data: currentSessionData,
    isError: currentSessionFailed,
    refetch: revalidateSession,
  } = currentSession;
  const sessionStillMatches =
    currentSessionData?.authenticated === true &&
    currentSessionData.scope === session.scope &&
    currentSessionData.email === session.email &&
    currentSessionData.roles.length === session.roles.length &&
    currentSessionData.roles.every((role, index) => role === session.roles[index]);
  const privateViewUnsafe = currentSessionFailed || !sessionStillMatches;

  useEffect(
    () =>
      subscribeToBackofficeSessionChanges(() => {
        void revalidateSession();
      }),
    [revalidateSession],
  );

  useEffect(() => {
    if (!currentSessionFailed && sessionStillMatches) return;
    if (intentionalLogout.current) return;
    queryClient.clear();
    router.replace(currentSessionData?.authenticated === true ? "/" : "/entrar");
    router.refresh();
  }, [
    currentSessionData?.authenticated,
    currentSessionFailed,
    queryClient,
    router,
    sessionStillMatches,
  ]);

  const logout = useMutation({
    mutationFn: () => logoutBackofficeClient(session.scope),
    onSuccess: () => {
      intentionalLogout.current = true;
      queryClient.clear();
      notifyBackofficeSessionChanged();
      router.replace("/entrar?saida=sucesso");
      router.refresh();
    },
  });

  if (privateViewUnsafe) {
    return (
      <main className={styles.main} id="conteudo-principal">
        <p role="status">Encerrando a visualização privada…</p>
      </main>
    );
  }

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
