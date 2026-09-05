import {
  backofficeStudioReviewDetailSchema,
  type BackofficeStudioCommand,
  type BackofficeStudioCommandResult,
} from "@set-livre/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  BackofficeClientError,
  isAmbiguousBackofficeError,
} from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";
import { backofficeQueryKeys } from "../../apps/backoffice/src/domains/backoffice/components/query-keys";
import {
  discardCachedStudioReview,
  reconcileSuccessfulStudioReview,
  seedAuthoritativeStudioReview,
} from "../../apps/backoffice/src/domains/backoffice/components/studio-review-cache";
import {
  actionAcknowledgement,
  assertStudioCommandResultMatchesAttempt,
  isConclusiveBackofficeConflict,
  requiresAuthoritativeStudioReview,
  studioReviewAuthoritySnapshot,
  studioReviewErrorMessage,
  studioReviewReadErrorMessage,
} from "../../apps/backoffice/src/domains/backoffice/components/studio-review-state";
import {
  backofficeStudioReviewDetailFixture,
  backofficeStudioReviewTestIds,
  studioTestIds,
} from "./studio-test-fixture";

const reviewerId = backofficeStudioReviewTestIds.reviewerId;

function reviewDetail() {
  return backofficeStudioReviewDetailSchema.parse(backofficeStudioReviewDetailFixture());
}

const commandResult: BackofficeStudioCommandResult = {
  idempotencyKey: "a1000000-0000-4000-8000-000000000002",
  action: "backoffice.studio.approve",
  disabledFromStatus: null,
  draftRevisionId: null,
  publicationVersion: 3,
  publishedRevisionId: studioTestIds.revisionId,
  revisionId: studioTestIds.revisionId,
  scope: reviewerId,
  studioId: studioTestIds.studioId,
  studioStatus: "published",
};
const command: BackofficeStudioCommand = {
  action: "backoffice.studio.approve",
  expectedScope: reviewerId,
  idempotencyKey: "a1000000-0000-4000-8000-000000000002",
  payload: {
    expectedPublicationVersion: 2,
    expectedRevisionId: studioTestIds.revisionId,
    studioId: studioTestIds.studioId,
  },
};

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("FEAT-030 studio review client state", () => {
  it.each([command.idempotencyKey, command.idempotencyKey.toUpperCase()])(
    "matches a canonical ledger key without accepting a different attempt (%s)",
    (idempotencyKey) => {
      const submitted = { ...command, idempotencyKey };
      expect(assertStudioCommandResultMatchesAttempt(submitted, commandResult)).toBe(commandResult);
      expect(() =>
        assertStudioCommandResultMatchesAttempt(submitted, {
          ...commandResult,
          idempotencyKey: "a1000000-0000-4000-8000-000000000099",
        }),
      ).toThrow("não corresponde à tentativa enviada");
    },
  );

  it("binds the acknowledgement copy to the decision action, not to the mixed studio state", () => {
    expect(actionAcknowledgement("backoffice.studio.approve")).toBe(
      "Revisei a candidata, a versão vigente e o impacto desta ação",
    );
    expect(actionAcknowledgement("backoffice.studio.reject")).toBe(
      "Revisei a candidata, a versão vigente e o impacto desta ação",
    );
    expect(actionAcknowledgement("backoffice.studio.disable")).toBe(
      "Revisei a publicação, o estado editorial e o impacto desta ação",
    );
    expect(actionAcknowledgement("backoffice.studio.restore")).toBe(
      "Revisei a publicação, o estado editorial e o impacto desta ação",
    );
  });

  it("keeps the editorial snapshot stable when only signed preview credentials are renewed", () => {
    const current = reviewDetail();
    const renewed = backofficeStudioReviewDetailSchema.parse({
      ...current,
      candidateRevision: {
        ...current.candidateRevision,
        media: current.candidateRevision.media.map((media) => ({
          ...media,
          previewUrl: "https://project.supabase.co/storage/v1/object/sign/preview-b",
        })),
      },
      previewExpiresAt: "2026-09-01T20:10:00.000Z",
    });

    expect(studioReviewAuthoritySnapshot(renewed)).toBe(studioReviewAuthoritySnapshot(current));
    expect(studioReviewAuthoritySnapshot({ ...renewed, publicationVersion: 3 })).not.toBe(
      studioReviewAuthoritySnapshot(current),
    );
  });

  it("replaces a fresh same-key cache entry with the newest authoritative SSR detail", () => {
    const client = queryClient();
    const current = reviewDetail();
    const stale = backofficeStudioReviewDetailSchema.parse({
      ...current,
      candidateRevision: { ...current.candidateRevision, name: "Estúdio Aurora anterior" },
      publicationVersion: 1,
    });
    const key = backofficeQueryKeys.studio(reviewerId, studioTestIds.studioId);
    client.setQueryData(key, stale);

    seedAuthoritativeStudioReview({
      detail: current,
      queryClient: client,
      scope: reviewerId,
      studioId: studioTestIds.studioId,
    });

    expect(client.getQueryData(key)).toEqual(current);
    expect(() =>
      seedAuthoritativeStudioReview({
        detail: current,
        queryClient: client,
        scope: reviewerId,
        studioId: studioTestIds.otherStudioId,
      }),
    ).toThrow("outra fronteira");
  });

  it("separates ambiguous command recovery from a failed authoritative read", () => {
    const unavailable = new BackofficeClientError({
      code: "SERVICE_UNAVAILABLE",
      message: "A leitura autoritativa está indisponível.",
      status: 503,
    });
    expect(studioReviewErrorMessage(unavailable)).toContain("mesma tentativa");
    expect(studioReviewErrorMessage(unavailable)).toContain("idempotente");
    expect(studioReviewReadErrorMessage(unavailable)).toBe(
      "A leitura autoritativa está indisponível.",
    );
    expect(studioReviewReadErrorMessage(new Error("network"))).toContain("nova leitura");
  });

  it("classifies every typed 409 as a conclusive conflict and no transport failure as one", () => {
    expect(
      isConclusiveBackofficeConflict(
        new BackofficeClientError({
          code: "CONFLICT",
          message: "Conflito conclusivo.",
          status: 409,
        }),
      ),
    ).toBe(true);
    expect(
      isConclusiveBackofficeConflict(
        new BackofficeClientError({
          code: "STALE_STATE",
          message: "Snapshot vencido.",
          status: 409,
        }),
      ),
    ).toBe(true);
    expect(
      isConclusiveBackofficeConflict(
        new BackofficeClientError({
          code: "SERVICE_UNAVAILABLE",
          message: "Resultado incerto.",
          status: 503,
        }),
      ),
    ).toBe(false);
    expect(isConclusiveBackofficeConflict(new Error("network"))).toBe(false);
    expect(
      requiresAuthoritativeStudioReview(
        new BackofficeClientError({
          code: "NOT_FOUND",
          message: "O caso deixou de existir.",
          status: 404,
        }),
      ),
    ).toBe(true);
    expect(
      requiresAuthoritativeStudioReview(
        new BackofficeClientError({
          code: "VALIDATION_FAILED",
          message: "Entrada inválida.",
          status: 422,
        }),
      ),
    ).toBe(false);
  });

  it("accepts only a command result bound to the exact attempt and keeps mismatches ambiguous", () => {
    expect(assertStudioCommandResultMatchesAttempt(command, commandResult)).toBe(commandResult);

    const differentAction: BackofficeStudioCommandResult = {
      idempotencyKey: command.idempotencyKey,
      action: "backoffice.studio.reject",
      disabledFromStatus: null,
      draftRevisionId: studioTestIds.otherStudioId,
      publicationVersion: 3,
      publishedRevisionId: null,
      revisionId: studioTestIds.revisionId,
      scope: reviewerId,
      studioId: studioTestIds.studioId,
      studioStatus: "rejected",
    };
    const mismatches: BackofficeStudioCommandResult[] = [
      { ...commandResult, scope: studioTestIds.otherUserId },
      { ...commandResult, studioId: studioTestIds.otherStudioId },
      differentAction,
      { ...commandResult, publicationVersion: 4 },
      { ...commandResult, revisionId: "88888888-8888-4888-8888-888888888888" },
    ];
    for (const mismatch of mismatches) {
      let rejection: unknown;
      try {
        assertStudioCommandResultMatchesAttempt(command, mismatch);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({ code: "RESPONSE_INVALID", status: 200 });
      expect(isAmbiguousBackofficeError(rejection)).toBe(true);
    }
  });

  it("writes the fresh detail and invalidates the real local queue and detail keys", async () => {
    const client = queryClient();
    const detailKey = backofficeQueryKeys.studio(reviewerId, studioTestIds.studioId);
    const queueKey = backofficeQueryKeys.studios(reviewerId);
    const unrelatedKey = backofficeQueryKeys.studio(reviewerId, studioTestIds.otherStudioId);
    const current = reviewDetail();
    const refreshed = backofficeStudioReviewDetailSchema.parse({
      ...current,
      candidateRevision: { ...current.candidateRevision, name: "Estúdio Aurora confirmado" },
    });

    for (const key of [detailKey, queueKey, unrelatedKey]) {
      client.setQueryData(key, key === detailKey ? current : { cached: true });
    }

    await reconcileSuccessfulStudioReview({
      queryClient: client,
      readDetail: async () => refreshed,
      result: commandResult,
      scope: reviewerId,
    });

    expect(client.getQueryData(detailKey)).toEqual(refreshed);
    for (const key of [queueKey, detailKey]) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    expect(client.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  });

  it("cancels and removes the private detail before a conclusive authoritative read", async () => {
    const client = queryClient();
    const detailKey = backofficeQueryKeys.studio(reviewerId, studioTestIds.studioId);
    const unrelatedKey = backofficeQueryKeys.studio(reviewerId, studioTestIds.otherStudioId);
    client.setQueryData(detailKey, reviewDetail());
    client.setQueryData(unrelatedKey, { cached: true });

    await discardCachedStudioReview({
      queryClient: client,
      scope: reviewerId,
      studioId: studioTestIds.studioId,
    });

    expect(client.getQueryData(detailKey)).toBeUndefined();
    expect(client.getQueryData(unrelatedKey)).toEqual({ cached: true });
  });

  it("removes a stale detail when the successful transition makes it unavailable", async () => {
    const client = queryClient();
    const detailKey = backofficeQueryKeys.studio(reviewerId, studioTestIds.studioId);
    client.setQueryData(detailKey, reviewDetail());

    await reconcileSuccessfulStudioReview({
      queryClient: client,
      readDetail: async () => {
        throw new BackofficeClientError({
          code: "NOT_FOUND",
          message: "A revisão não está mais disponível.",
          status: 404,
        });
      },
      result: commandResult,
      scope: reviewerId,
    });

    expect(client.getQueryData(detailKey)).toBeUndefined();
  });
});
