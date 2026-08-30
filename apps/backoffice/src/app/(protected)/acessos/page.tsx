import { redirect } from "next/navigation";

import { UserDirectory } from "@/domains/backoffice/components/user-directory";
import { readComponentBackofficeSession } from "@/domains/backoffice/server/backoffice-session";

export default async function BackofficeAccessPage() {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) return null;
  if (!session.roles.includes("admin")) redirect("/usuarios");
  return <UserDirectory mode="access" session={session} />;
}
