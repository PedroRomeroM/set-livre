import type {
  BackofficeStudioCommand,
  BackofficeStudioCommandResult,
  BackofficeStudioReviewDetail,
} from "@set-livre/contracts";

import { BackofficeClientError, isAmbiguousBackofficeError } from "./backoffice-api";

export type ReviewAction = BackofficeStudioCommand["action"];
export type ReviewRevision = BackofficeStudioReviewDetail["candidateRevision"];
export type MediaLoadState = "error" | "loaded";

export const actionLabels: Record<ReviewAction, string> = {
  "backoffice.studio.approve": "Aprovar e publicar",
  "backoffice.studio.disable": "Desativar publicação",
  "backoffice.studio.reject": "Rejeitar e devolver para correção",
  "backoffice.studio.restore": "Restaurar publicação",
};

export function actionAcknowledgement(action: ReviewAction) {
  switch (action) {
    case "backoffice.studio.approve":
    case "backoffice.studio.reject":
      return "Revisei a candidata, a versão vigente e o impacto desta ação";
    case "backoffice.studio.disable":
    case "backoffice.studio.restore":
      return "Revisei a publicação, o estado editorial e o impacto desta ação";
  }
}

export const revisionStatusLabels: Record<ReviewRevision["status"], string> = {
  approved: "Aprovada",
  draft: "Rascunho",
  pending: "Em revisão",
  rejected: "Rejeitada",
  superseded: "Substituída",
};

export const studioStatusLabels: Record<BackofficeStudioReviewDetail["studioStatus"], string> = {
  changes_pending: "Publicado com alterações em revisão",
  disabled: "Publicação desativada",
  draft: "Rascunho",
  paused: "Publicação pausada",
  pending_review: "Primeira publicação em revisão",
  published: "Publicado",
  rejected: "Rejeitado",
};

export const reviewStateLabels: Record<BackofficeStudioReviewDetail["reviewState"], string> = {
  disabled: "Restauração administrativa",
  moderation: "Moderação administrativa",
  reviewPending: "Decisão editorial pendente",
};

export const checklistLabels: Record<
  BackofficeStudioReviewDetail["checklist"][number]["key"],
  string
> = {
  content: "Conteúdo, taxonomias e perguntas frequentes",
  details: "Dados principais e endereço",
  media: "Mídia",
};

export function studioReviewErrorMessage(error: unknown) {
  if (isAmbiguousBackofficeError(error)) {
    return "O resultado não pôde ser confirmado. Repita a mesma tentativa para consultar o registro idempotente.";
  }
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível concluir agora. Tente novamente.";
}

export function studioReviewReadErrorMessage(error: unknown) {
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível confirmar o estado atual. Tente fazer uma nova leitura.";
}

export function isNotFoundStudioReview(error: unknown) {
  return error instanceof BackofficeClientError && error.status === 404;
}

export function isConclusiveBackofficeConflict(error: unknown) {
  return error instanceof BackofficeClientError && error.status === 409;
}

export function requiresAuthoritativeStudioReview(error: unknown) {
  return isNotFoundStudioReview(error) || isConclusiveBackofficeConflict(error);
}

function revisionAuthoritySnapshot(revision: ReviewRevision) {
  return {
    ...revision,
    media: revision.media.map(({ previewUrl, ...media }) => {
      void previewUrl;
      return media;
    }),
  };
}

export function studioReviewAuthoritySnapshot(detail: BackofficeStudioReviewDetail) {
  const { previewExpiresAt, ...authority } = detail;
  void previewExpiresAt;
  return JSON.stringify({
    ...authority,
    candidateRevision: revisionAuthoritySnapshot(detail.candidateRevision),
    publishedRevision:
      detail.publishedRevision === null
        ? null
        : revisionAuthoritySnapshot(detail.publishedRevision),
  });
}

function invalidStudioCommandResult(): never {
  throw new BackofficeClientError({
    code: "RESPONSE_INVALID",
    message: "O servidor retornou uma confirmação que não corresponde à tentativa enviada.",
    status: 200,
  });
}

export function assertStudioCommandResultMatchesAttempt(
  command: BackofficeStudioCommand,
  result: BackofficeStudioCommandResult,
) {
  const expectedRevisionId =
    command.action === "backoffice.studio.approve" || command.action === "backoffice.studio.reject"
      ? command.payload.expectedRevisionId
      : undefined;
  if (
    result.scope !== command.expectedScope ||
    result.studioId !== command.payload.studioId ||
    result.action !== command.action ||
    result.publicationVersion !== command.payload.expectedPublicationVersion + 1 ||
    (expectedRevisionId !== undefined && result.revisionId !== expectedRevisionId)
  ) {
    invalidStudioCommandResult();
  }
  return result;
}

export function mediaKey(revisionId: string, mediaId: string, previewUrl: string) {
  return `${revisionId}:${mediaId}:${previewUrl}`;
}

export function recordMediaState(
  current: Readonly<Record<string, MediaLoadState>>,
  key: string,
  state: MediaLoadState,
) {
  const previous = current[key];
  return previous === state || (previous === "error" && state === "loaded")
    ? current
    : { ...current, [key]: state };
}

export function requiredMediaKeys(detail: BackofficeStudioReviewDetail) {
  return [detail.candidateRevision, detail.publishedRevision]
    .filter((revision): revision is ReviewRevision => revision !== null)
    .flatMap((revision) =>
      revision.media.map((media) => mediaKey(revision.id, media.id, media.previewUrl)),
    );
}

export function actionImpact(action: ReviewAction, detail: BackofficeStudioReviewDetail) {
  switch (action) {
    case "backoffice.studio.approve":
      return "A candidata substituirá atomicamente a versão pública. Se o estúdio estiver pausado, continuará pausado.";
    case "backoffice.studio.disable":
      return `A publicação ficará indisponível. O estado “${studioStatusLabels[detail.studioStatus]}” será preservado como destino único da restauração.`;
    case "backoffice.studio.reject":
      return "A versão pública atual permanecerá intacta e uma nova revisão editável será criada para o dono.";
    case "backoffice.studio.restore":
      return detail.disabledFromStatus === null
        ? "A restauração está bloqueada porque o estado de destino não foi confirmado."
        : `O estúdio voltará exatamente para “${studioStatusLabels[detail.disabledFromStatus]}”.`;
  }
}

export function availableActions(detail: BackofficeStudioReviewDetail): ReviewAction[] {
  const actions: ReviewAction[] = [];
  if (detail.canApprove) actions.push("backoffice.studio.approve");
  if (detail.canReject) actions.push("backoffice.studio.reject");
  if (detail.canDisable) actions.push("backoffice.studio.disable");
  if (detail.canRestore) actions.push("backoffice.studio.restore");
  return actions;
}

export function commandForAction(input: {
  action: ReviewAction;
  detail: BackofficeStudioReviewDetail;
  reason: string;
  scope: string;
}): BackofficeStudioCommand {
  const boundary = {
    expectedPublicationVersion: input.detail.publicationVersion,
    studioId: input.detail.studioId,
  };
  const envelope = {
    expectedScope: input.scope,
    idempotencyKey: crypto.randomUUID(),
  };
  switch (input.action) {
    case "backoffice.studio.approve":
      return {
        action: input.action,
        ...envelope,
        payload: { ...boundary, expectedRevisionId: input.detail.candidateRevision.id },
      };
    case "backoffice.studio.reject":
      return {
        action: input.action,
        ...envelope,
        payload: {
          ...boundary,
          expectedRevisionId: input.detail.candidateRevision.id,
          reason: input.reason.trim(),
        },
      };
    case "backoffice.studio.disable":
      return { action: input.action, ...envelope, payload: boundary };
    case "backoffice.studio.restore":
      return { action: input.action, ...envelope, payload: boundary };
  }
}
