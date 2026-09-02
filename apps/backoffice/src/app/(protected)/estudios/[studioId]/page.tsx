import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import {
  backofficeLandingPath,
  canReviewBackofficeStudios,
} from "@/domains/backoffice/backoffice-authorization";
import { StudioReviewDetail } from "@/domains/backoffice/components/studio-review-detail";
import { readBackofficeStudioReview } from "@/domains/backoffice/server/backoffice-service";
import {
  readComponentBackofficeState,
  toBrowserBackofficeSession,
} from "@/domains/backoffice/server/backoffice-session";
import { BackofficeApiError } from "@/lib/server/api-route";

export default async function BackofficeStudioReviewPage({
  params,
}: {
  params: Promise<{ studioId: string }>;
}) {
  const state = await readComponentBackofficeState();
  if (state === undefined) return null;
  if (!canReviewBackofficeStudios(state.session.roles)) {
    redirect(backofficeLandingPath(state.session.roles));
  }
  const parsedStudioId = z.uuid().safeParse((await params).studioId);
  if (!parsedStudioId.success) notFound();

  let detail;
  try {
    detail = await readBackofficeStudioReview({
      auth: state.auth,
      client: state.client,
      studioId: parsedStudioId.data,
    });
  } catch (error) {
    if (error instanceof BackofficeApiError && error.status === 404) notFound();
    throw error;
  }
  const browserSession = await toBrowserBackofficeSession(state.session);
  if (!browserSession.authenticated) return null;
  return <StudioReviewDetail initialDetail={detail} session={browserSession} />;
}
