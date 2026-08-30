import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { BackofficeNavigation } from "@/domains/backoffice/components/backoffice-navigation";
import { BackofficeShell } from "@/domains/backoffice/components/backoffice-shell";
import {
  readComponentBackofficeSession,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";

export const dynamic = "force-dynamic";

export default async function ProtectedBackofficeLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) redirect("/entrar");
  const browserSession = await toBrowserBackofficeSession(session);
  if (!browserSession.authenticated) redirect("/entrar");
  return (
    <BackofficeShell
      navigation={<BackofficeNavigation roles={session.roles} />}
      session={browserSession}
    >
      {children}
    </BackofficeShell>
  );
}
