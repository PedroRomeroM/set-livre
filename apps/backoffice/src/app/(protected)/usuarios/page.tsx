import { redirect } from "next/navigation";

import {
  backofficeLandingPath,
  canManageBackofficeUsers,
} from "@/domains/backoffice/backoffice-authorization";
import { UserDirectory } from "@/domains/backoffice/components/user-directory";
import {
  readComponentBackofficeSession,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";

export default async function BackofficeUsersPage() {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) return null;
  if (!canManageBackofficeUsers(session.roles)) redirect(backofficeLandingPath(session.roles));
  const browserSession = await toBrowserBackofficeSession(session);
  if (!browserSession.authenticated) return null;
  return <UserDirectory mode="users" session={browserSession} />;
}
