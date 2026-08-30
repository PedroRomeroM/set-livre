import { UserDirectory } from "@/domains/backoffice/components/user-directory";
import { readComponentBackofficeSession } from "@/domains/backoffice/server/backoffice-session";

export default async function BackofficeUsersPage() {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) return null;
  return <UserDirectory mode="users" session={session} />;
}
