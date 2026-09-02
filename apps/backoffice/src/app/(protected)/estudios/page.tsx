import { redirect } from "next/navigation";

import {
  backofficeLandingPath,
  canReviewBackofficeStudios,
} from "@/domains/backoffice/backoffice-authorization";
import { StudioReviewQueue } from "@/domains/backoffice/components/studio-review-queue";
import {
  readComponentBackofficeSession,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";

export default async function BackofficeStudiosPage() {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) return null;
  if (!canReviewBackofficeStudios(session.roles)) {
    redirect(backofficeLandingPath(session.roles));
  }
  const browserSession = await toBrowserBackofficeSession(session);
  if (!browserSession.authenticated) return null;
  return <StudioReviewQueue session={browserSession} />;
}
