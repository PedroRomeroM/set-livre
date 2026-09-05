import { redirect } from "next/navigation";

import { UserDirectory } from "@/domains/backoffice/components/user-directory";
import { backofficeLandingPath } from "@/domains/backoffice/backoffice-authorization";
import {
  readComponentBackofficeSession,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";

export default async function BackofficeAccessPage() {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) return null;
  if (!session.roles.includes("admin")) redirect(backofficeLandingPath(session.roles));
  const browserSession = await toBrowserBackofficeSession(session);
  if (!browserSession.authenticated) return null;
  return <UserDirectory mode="access" session={browserSession} />;
}
