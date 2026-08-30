import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { BackofficeShell } from "@/domains/backoffice/components/backoffice-shell";
import { readComponentBackofficeSession } from "@/domains/backoffice/server/backoffice-session";

export const dynamic = "force-dynamic";

export default async function ProtectedBackofficeLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) redirect("/entrar");
  return <BackofficeShell session={session}>{children}</BackofficeShell>;
}
