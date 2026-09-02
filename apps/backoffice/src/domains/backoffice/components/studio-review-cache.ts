import type {
  BackofficeStudioCommandResult,
  BackofficeStudioReviewDetail,
} from "@set-livre/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { readBackofficeStudioReviewClient } from "./backoffice-api";
import { backofficeQueryKeys } from "./query-keys";

function assertStudioReviewBoundary(
  detail: BackofficeStudioReviewDetail,
  scope: string,
  studioId: string,
) {
  if (detail.scope !== scope || detail.studioId !== studioId) {
    throw new Error("O detalhe autoritativo retornou outra fronteira de revisão.");
  }
  return detail;
}

export function seedAuthoritativeStudioReview(input: {
  detail: BackofficeStudioReviewDetail;
  queryClient: QueryClient;
  scope: string;
  studioId: string;
}) {
  const detail = assertStudioReviewBoundary(input.detail, input.scope, input.studioId);
  const queryKey = backofficeQueryKeys.studio(input.scope, detail.studioId);
  input.queryClient.removeQueries({ exact: true, queryKey });
  input.queryClient.setQueryData(queryKey, detail);
}

export async function discardCachedStudioReview(input: {
  queryClient: QueryClient;
  scope: string;
  studioId: string;
}) {
  const queryKey = backofficeQueryKeys.studio(input.scope, input.studioId);
  await input.queryClient.cancelQueries({ exact: true, queryKey });
  input.queryClient.removeQueries({ exact: true, queryKey });
}

export async function reconcileSuccessfulStudioReview(input: {
  queryClient: QueryClient;
  readDetail?: (studioId: string) => Promise<BackofficeStudioReviewDetail>;
  result: BackofficeStudioCommandResult;
  scope: string;
}) {
  const detailKey = backofficeQueryKeys.studio(input.scope, input.result.studioId);
  await input.queryClient.cancelQueries({ exact: true, queryKey: detailKey });
  try {
    const detail = assertStudioReviewBoundary(
      input.readDetail === undefined
        ? await readBackofficeStudioReviewClient({
            expectedScope: input.scope,
            studioId: input.result.studioId,
          })
        : await input.readDetail(input.result.studioId),
      input.scope,
      input.result.studioId,
    );
    input.queryClient.setQueryData(detailKey, detail);
  } catch {
    input.queryClient.removeQueries({ exact: true, queryKey: detailKey });
  }
  await Promise.all([
    input.queryClient.invalidateQueries({
      exact: true,
      queryKey: backofficeQueryKeys.studios(input.scope),
      refetchType: "none",
    }),
    input.queryClient.invalidateQueries({
      exact: true,
      queryKey: detailKey,
      refetchType: "none",
    }),
  ]);
}
