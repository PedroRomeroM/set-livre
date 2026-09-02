import { redirect } from "next/navigation";

import { readComponentBackofficeSession } from "@/domains/backoffice/server/backoffice-session";
import { backofficeLandingPath } from "@/domains/backoffice/backoffice-authorization";

export const dynamic = "force-dynamic";

export default async function BackofficeEntryPage() {
  const session = await readComponentBackofficeSession();
  redirect(session.authenticated ? backofficeLandingPath(session.roles) : "/entrar");
}
