import { UserDirectory } from "@/domains/backoffice/components/user-directory";
import {
  readComponentBackofficeSession,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";

export default async function BackofficeUsersPage() {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) return null;
  const browserSession = await toBrowserBackofficeSession(session);
  if (!browserSession.authenticated) return null;
  return <UserDirectory mode="users" session={browserSession} />;
}
