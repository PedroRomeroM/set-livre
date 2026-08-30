import { redirect } from "next/navigation";

import { readComponentBackofficeSession } from "@/domains/backoffice/server/backoffice-session";

export const dynamic = "force-dynamic";

export default async function BackofficeEntryPage() {
  const session = await readComponentBackofficeSession();
  redirect(session.authenticated ? "/usuarios" : "/entrar");
}
