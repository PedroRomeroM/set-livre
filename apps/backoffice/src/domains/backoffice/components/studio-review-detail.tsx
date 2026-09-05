"use client";

import type {
  BackofficeSession,
  BackofficeStudioCommand,
  BackofficeStudioCommandResult,
  BackofficeStudioReviewDetail,
  BackofficeStudioReadActivity,
} from "@set-livre/contracts";
import { Alert, Button, ButtonLink, Checkbox, Field, Textarea } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  executeBackofficeStudioCommand,
  isAmbiguousBackofficeError,
  readBackofficeStudioReviewClient,
} from "./backoffice-api";
import styles from "./backoffice.module.css";
import { backofficeQueryKeys } from "./query-keys";
import {
  discardCachedStudioReview,
  reconcileSuccessfulStudioReview,
  seedAuthoritativeStudioReview,
} from "./studio-review-cache";
import reviewStyles from "./studio-review.module.css";
import { StudioReviewRevisionPanel } from "./studio-review-revision-panel";
import {
  actionAcknowledgement,
  actionImpact,
  actionLabels,
  assertStudioCommandResultMatchesAttempt,
  availableActions,
  checklistLabels,
  commandForAction,
  isNotFoundStudioReview,
  recordMediaState,
  requiredMediaKeys,
  requiresAuthoritativeStudioReview,
  reviewStateLabels,
  studioReviewAuthoritySnapshot,
  studioReviewReadErrorMessage,
  studioReviewErrorMessage,
  studioStatusLabels,
  type MediaLoadState,
  type ReviewAction,
} from "./studio-review-state";
import { useBackofficeHydrated } from "./use-backoffice-hydrated";

type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;
type PendingDecision = Readonly<{ command: BackofficeStudioCommand; snapshot: string }>;
type ReviewDecision = Readonly<{
  action: ReviewAction;
  detail: BackofficeStudioReviewDetail;
  snapshot: string;
}>;

function StudioReviewUnavailable({ notice }: { notice: string | undefined }) {
  return (
    <section aria-labelledby="studio-review-unavailable" className={styles.pageStack}>
      {notice === undefined ? null : <Alert>{notice}</Alert>}
      <Alert title="Revisão não disponível" variant="error">
        <p id="studio-review-unavailable">
          Este caso não está mais disponível para esta sessão. Nenhum detalhe anterior foi
          preservado nesta superfície.
        </p>
      </Alert>
      <div>
        <ButtonLink href="/estudios">Voltar aos estúdios</ButtonLink>
      </div>
    </section>
  );
}

export function StudioReviewDetail({
  initialDetail,
  session,
}: {
  initialDetail: BackofficeStudioReviewDetail;
  session: AuthenticatedSession;
}) {
  const interactive = useBackofficeHydrated();
  const queryClient = useQueryClient();
  const [completed, setCompleted] = useState<BackofficeStudioCommandResult>();
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string>();
  const [decision, setDecision] = useState<ReviewDecision>();
  const [expiredPreviewIdentity, setExpiredPreviewIdentity] = useState<string>();
  const [mediaStates, setMediaStates] = useState<Readonly<Record<string, MediaLoadState>>>({});
  const [interactiveReadError, setInteractiveReadError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [pendingSnapshot, setPendingSnapshot] = useState<string>();
  const [preparedInitialDetail, setPreparedInitialDetail] =
    useState<BackofficeStudioReviewDetail>();
  const [rejectionReason, setRejectionReason] = useState<
    Readonly<{
      snapshot: string;
      value: string;
    }>
  >();
  const [refreshing, setRefreshing] = useState(false);
  const [requiresAuthoritativeRead, setRequiresAuthoritativeRead] = useState(false);
  const [terminalUnavailableFor, setTerminalUnavailableFor] = useState<
    Readonly<{
      detail: BackofficeStudioReviewDetail;
      identity: string;
    }>
  >();
  const [openingDecision, setOpeningDecision] = useState<ReviewAction>();
  const actionButtons = useRef<Partial<Record<ReviewAction, HTMLButtonElement | null>>>({});
  const completionRef = useRef<HTMLElement>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  const decisionOpening = useRef(false);
  const interactiveReadController = useRef<AbortController | undefined>(undefined);
  const pendingDecision = useRef<PendingDecision | undefined>(undefined);
  const returnFocusAction = useRef<ReviewAction | undefined>(undefined);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const clearAttempt = useCallback((scope: "attempt" | "decision") => {
    pendingDecision.current = undefined;
    setPendingSnapshot(undefined);
    if (scope === "decision") {
      setConfirmedSnapshot(undefined);
      setRejectionReason(undefined);
      setDecision(undefined);
    }
  }, []);
  const detailIdentity = `${session.scope}:${initialDetail.studioId}`;
  const terminallyUnavailable =
    terminalUnavailableFor?.detail === initialDetail &&
    terminalUnavailableFor.identity === detailIdentity;
  const seedIsCurrent = preparedInitialDetail === initialDetail;
  const automaticRefetchEnabled =
    seedIsCurrent &&
    !terminallyUnavailable &&
    !requiresAuthoritativeRead &&
    completed === undefined &&
    pendingSnapshot === undefined &&
    decision === undefined &&
    openingDecision === undefined;
  const detailQueryKey = useMemo(
    () => backofficeQueryKeys.studio(session.scope, initialDetail.studioId),
    [initialDetail.studioId, session.scope],
  );
  async function readDetail(activity: BackofficeStudioReadActivity, signal?: AbortSignal) {
    try {
      return await readBackofficeStudioReviewClient(
        { activity, expectedScope: session.scope, studioId: initialDetail.studioId },
        signal,
      );
    } catch (error) {
      if (isNotFoundStudioReview(error)) {
        clearAttempt("decision");
        setNotice("O caso deixou de estar disponível e o estado privado anterior foi descartado.");
        setTerminalUnavailableFor({ detail: initialDetail, identity: detailIdentity });
      }
      throw error;
    }
  }
  const review = useQuery({
    enabled: automaticRefetchEnabled,
    queryFn: ({ signal }) => readDetail("passive", signal),
    queryKey: detailQueryKey,
    refetchInterval: automaticRefetchEnabled ? 4 * 60 * 1_000 : false,
    refetchOnReconnect: automaticRefetchEnabled,
    refetchOnWindowFocus: automaticRefetchEnabled,
    retry: false,
  });
  async function refetchInteractiveDetail() {
    await queryClient.cancelQueries({ exact: true, queryKey: detailQueryKey });
    interactiveReadController.current?.abort(
      new DOMException("A leitura interativa foi substituída.", "AbortError"),
    );
    const controller = new AbortController();
    interactiveReadController.current = controller;
    setInteractiveReadError(undefined);
    try {
      const detail = await readDetail("interactive", controller.signal);
      queryClient.setQueryData(detailQueryKey, detail);
      return true;
    } catch (error) {
      if (!controller.signal.aborted) setInteractiveReadError(error);
      return false;
    } finally {
      if (interactiveReadController.current === controller) {
        interactiveReadController.current = undefined;
      }
    }
  }
  const authoritativeDetail = seedIsCurrent && !terminallyUnavailable ? review.data : undefined;
  const snapshot =
    authoritativeDetail === undefined
      ? undefined
      : studioReviewAuthoritySnapshot(authoritativeDetail);
  const selectedAction = decision?.action;
  const reason =
    rejectionReason !== undefined && rejectionReason.snapshot === decision?.snapshot
      ? rejectionReason.value
      : "";
  const previewExpiresAt = authoritativeDetail?.previewExpiresAt ?? null;
  const requiredPreviews = useMemo(
    () => (authoritativeDetail === undefined ? [] : requiredMediaKeys(authoritativeDetail)),
    [authoritativeDetail],
  );
  const previewIdentity = JSON.stringify([previewExpiresAt, ...requiredPreviews]);

  useEffect(() => {
    let active = true;
    seedAuthoritativeStudioReview({
      detail: initialDetail,
      queryClient,
      scope: session.scope,
      studioId: initialDetail.studioId,
    });
    queueMicrotask(() => {
      if (active) setPreparedInitialDetail(initialDetail);
    });
    return () => {
      active = false;
    };
  }, [initialDetail, queryClient, session.scope]);

  useEffect(
    () => () => {
      interactiveReadController.current?.abort(
        new DOMException("A revisão foi encerrada.", "AbortError"),
      );
    },
    [],
  );

  async function discardAndRefreshAuthoritativeDetail(error: unknown) {
    const notFound = isNotFoundStudioReview(error);
    clearAttempt("decision");
    setNotice(
      notFound
        ? "O caso deixou de estar disponível. O estado anterior foi descartado antes da nova leitura."
        : "O caso mudou. O estado anterior foi descartado antes da nova leitura.",
    );
    setRequiresAuthoritativeRead(true);
    setTerminalUnavailableFor(undefined);
    setRefreshing(true);
    setExpiredPreviewIdentity(undefined);
    setMediaStates({});
    await discardCachedStudioReview({
      queryClient,
      scope: session.scope,
      studioId: initialDetail.studioId,
    });
    const refreshed = await refetchInteractiveDetail();
    setRefreshing(false);
    if (refreshed) {
      setRequiresAuthoritativeRead(false);
      setNotice(
        notFound
          ? "O servidor confirmou novamente o caso autoritativo para uma nova revisão."
          : "O caso mudou. O estado autoritativo foi recarregado para uma nova revisão.",
      );
      return;
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      const pending = pendingDecision.current;
      if (pending === undefined) {
        throw new Error("A decisão editorial não possui uma solicitação idempotente preservada.");
      }
      const command = pending.command;
      return executeBackofficeStudioCommand(command).then((result) =>
        assertStudioCommandResultMatchesAttempt(command, result),
      );
    },
    networkMode: "always",
    onError: async (error) => {
      if (requiresAuthoritativeStudioReview(error)) {
        await discardAndRefreshAuthoritativeDetail(error);
        return;
      }
      if (!isAmbiguousBackofficeError(error)) {
        clearAttempt("attempt");
      }
    },
    onSuccess: async (result) => {
      clearAttempt("decision");
      setCompleted(result);
      setExpiredPreviewIdentity(undefined);
      setMediaStates({});
      await reconcileSuccessfulStudioReview({ queryClient, result, scope: session.scope });
    },
  });

  useEffect(() => {
    if (!terminallyUnavailable) return;
    void discardCachedStudioReview({
      queryClient,
      scope: session.scope,
      studioId: initialDetail.studioId,
    });
  }, [initialDetail.studioId, queryClient, session.scope, terminallyUnavailable]);

  useEffect(() => {
    if (previewExpiresAt === null) return;
    const expiresAt = Date.parse(previewExpiresAt);
    const remaining = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : 0;
    const expiry = window.setTimeout(() => setExpiredPreviewIdentity(previewIdentity), remaining);
    return () => window.clearTimeout(expiry);
  }, [previewExpiresAt, previewIdentity]);

  useEffect(() => {
    if (selectedAction !== undefined) confirmationRef.current?.focus();
  }, [selectedAction]);

  useEffect(() => {
    const action = returnFocusAction.current;
    if (decision === undefined && openingDecision === undefined && action !== undefined) {
      returnFocusAction.current = undefined;
      actionButtons.current[action]?.focus();
    }
  }, [decision, openingDecision]);

  useEffect(() => {
    if (completed !== undefined) completionRef.current?.focus();
  }, [completed]);

  const retryAvailable =
    mutation.isError && isAmbiguousBackofficeError(mutation.error) && pendingSnapshot !== undefined;

  useEffect(() => {
    if (retryAvailable) submitButtonRef.current?.focus();
  }, [retryAvailable]);

  const previewExpired = expiredPreviewIdentity === previewIdentity;
  const previewFailed = requiredPreviews.some((key) => mediaStates[key] === "error");
  const previewsLoaded = requiredPreviews.every((key) => mediaStates[key] === "loaded");
  const previewsInspectable =
    requiredPreviews.length === 0 || (!previewExpired && !previewFailed && previewsLoaded);

  async function refreshAuthoritativeDetail(successNotice: string) {
    if (
      decisionOpening.current ||
      decision !== undefined ||
      pendingSnapshot !== undefined ||
      mutation.isPending
    ) {
      return;
    }
    clearAttempt("decision");
    mutation.reset();
    setNotice(undefined);
    setRequiresAuthoritativeRead(true);
    setTerminalUnavailableFor(undefined);
    setRefreshing(true);
    setExpiredPreviewIdentity(undefined);
    setMediaStates({});
    const refreshed = await refetchInteractiveDetail();
    setRefreshing(false);
    if (refreshed) {
      setRequiresAuthoritativeRead(false);
      setNotice(successNotice);
    }
  }

  async function beginDecision(action: ReviewAction, expectedSnapshot: string) {
    if (
      decisionOpening.current ||
      decision !== undefined ||
      pendingSnapshot !== undefined ||
      mutation.isPending ||
      retryAvailable
    ) {
      return;
    }
    decisionOpening.current = true;
    setOpeningDecision(action);
    try {
      await queryClient.cancelQueries({ exact: true, queryKey: detailQueryKey });
      const latestDetail = queryClient.getQueryData<BackofficeStudioReviewDetail>(detailQueryKey);
      if (
        latestDetail === undefined ||
        latestDetail.scope !== session.scope ||
        latestDetail.studioId !== initialDetail.studioId
      ) {
        setNotice(
          "Não foi possível confirmar a fronteira atual. Recarregue o caso antes de decidir.",
        );
        return;
      }
      const latestSnapshot = studioReviewAuthoritySnapshot(latestDetail);
      if (latestSnapshot !== expectedSnapshot || !availableActions(latestDetail).includes(action)) {
        setNotice(
          "O caso foi atualizado antes da confirmação. Revise o estado atual e selecione a ação novamente.",
        );
        return;
      }
      clearAttempt("decision");
      mutation.reset();
      setNotice(undefined);
      setDecision({ action, detail: latestDetail, snapshot: latestSnapshot });
    } finally {
      decisionOpening.current = false;
      setOpeningDecision(undefined);
    }
  }

  if (completed !== undefined) {
    return (
      <section
        aria-labelledby="studio-review-complete"
        className={styles.pageStack}
        ref={completionRef}
        tabIndex={-1}
      >
        <Alert>
          <h1 id="studio-review-complete">Operação confirmada</h1>
          <p>
            {actionLabels[completed.action]} concluída na versão editorial{" "}
            {completed.publicationVersion}.
          </p>
        </Alert>
        <div>
          <ButtonLink href="/estudios">Voltar aos estúdios</ButtonLink>
        </div>
      </section>
    );
  }

  if (terminallyUnavailable) {
    return <StudioReviewUnavailable notice={notice} />;
  }

  if (
    !seedIsCurrent ||
    refreshing ||
    (!requiresAuthoritativeRead && review.isPending && authoritativeDetail === undefined)
  ) {
    return (
      <section aria-busy aria-labelledby="studio-review-loading" className={styles.pageStack}>
        <h1 id="studio-review-loading">Confirmando o estado atual</h1>
        <p role="status">A revisão e as permissões estão sendo relidas antes de exibir o caso.</p>
      </section>
    );
  }

  const blockingReadError = requiresAuthoritativeRead ? interactiveReadError : review.error;
  if (
    blockingReadError !== null &&
    blockingReadError !== undefined &&
    (requiresAuthoritativeRead ||
      authoritativeDetail === undefined ||
      isNotFoundStudioReview(blockingReadError))
  ) {
    if (isNotFoundStudioReview(blockingReadError)) {
      return <StudioReviewUnavailable notice={notice} />;
    }
    return (
      <section aria-labelledby="studio-review-read-error" className={styles.pageStack}>
        <Alert title="Não foi possível confirmar o estado atual" variant="error">
          <p id="studio-review-read-error">{studioReviewReadErrorMessage(blockingReadError)}</p>
          <p>
            Os detalhes e as decisões permanecem fechados até uma leitura autoritativa concluir.
          </p>
          <div className={reviewStyles.actions}>
            <Button
              disabled={!interactive}
              onClick={() =>
                void refreshAuthoritativeDetail("O estado autoritativo foi carregado novamente.")
              }
              variant="secondary"
            >
              Tentar carregar novamente
            </Button>
          </div>
        </Alert>
        <div>
          <ButtonLink href="/estudios" variant="ghost">
            Voltar aos estúdios
          </ButtonLink>
        </div>
      </section>
    );
  }

  if (authoritativeDetail === undefined || snapshot === undefined) {
    return (
      <section aria-labelledby="studio-review-empty" className={styles.pageStack}>
        <Alert title="Revisão não disponível" variant="error">
          <p id="studio-review-empty">O servidor não confirmou um caso editorial válido.</p>
        </Alert>
      </section>
    );
  }

  const detail = authoritativeDetail;
  const confirmed = decision !== undefined && confirmedSnapshot === decision.snapshot;
  const backgroundReadFailed = review.isRefetchError && !isNotFoundStudioReview(review.error);
  const backgroundRefetching = review.isFetching && !requiresAuthoritativeRead;
  const manualRefetchLocked =
    decision !== undefined ||
    pendingSnapshot !== undefined ||
    mutation.isPending ||
    openingDecision !== undefined;
  const decisionLocked =
    !interactive ||
    decision !== undefined ||
    openingDecision !== undefined ||
    mutation.isPending ||
    retryAvailable ||
    review.isRefetchError ||
    !previewsInspectable;

  return (
    <section
      aria-busy={!interactive || mutation.isPending}
      aria-labelledby="studio-review-detail-title"
      className={styles.pageStack}
      inert={!interactive}
    >
      <header>
        <p className={styles.eyebrow}>Revisão editorial privada</p>
        <h1 id="studio-review-detail-title">{detail.candidateRevision.name}</h1>
        <p>
          Compare somente os fatos versionados abaixo. Toda decisão revalida o caso e a versão
          editorial {detail.publicationVersion} no banco.
        </p>
      </header>
      {notice === undefined ? null : <Alert>{notice}</Alert>}
      {backgroundRefetching ? (
        <p role="status">Atualizando o caso em segundo plano sem interromper sua revisão…</p>
      ) : null}
      {backgroundReadFailed ? (
        <Alert title="A atualização do caso falhou" variant="error">
          <p>{studioReviewReadErrorMessage(review.error)}</p>
          <p>
            O estado confirmado permanece visível e sua decisão em andamento foi preservada. Tente a
            leitura novamente antes de enviar uma nova ação.
          </p>
          {manualRefetchLocked ? (
            <p>
              Conclua ou cancele a confirmação atual. Se o resultado estiver incerto, repita somente
              a mesma tentativa idempotente.
            </p>
          ) : (
            <div className={reviewStyles.actions}>
              <Button
                disabled={!interactive || review.isFetching}
                loading={review.isFetching}
                loadingLabel="Atualizando novamente"
                onClick={() =>
                  void refreshAuthoritativeDetail("O estado autoritativo foi atualizado novamente.")
                }
                variant="secondary"
              >
                Tentar atualizar novamente
              </Button>
            </div>
          )}
        </Alert>
      ) : null}
      <section aria-labelledby="review-status-title" className={reviewStyles.section}>
        <h2 id="review-status-title">Estado confirmado</h2>
        <dl className={reviewStyles.definitionList}>
          <dt>Estado do estúdio</dt>
          <dd>{studioStatusLabels[detail.studioStatus]}</dd>
          <dt>Etapa operacional</dt>
          <dd>{reviewStateLabels[detail.reviewState]}</dd>
          <dt>Versão editorial</dt>
          <dd>{detail.publicationVersion}</dd>
          {detail.disabledFromStatus === null ? null : (
            <>
              <dt>Destino da restauração</dt>
              <dd>{studioStatusLabels[detail.disabledFromStatus]}</dd>
            </>
          )}
        </dl>
      </section>
      <section aria-labelledby="review-checklist-title" className={reviewStyles.section}>
        <h2 id="review-checklist-title">Checklist de publicação</h2>
        <ul className={reviewStyles.checklist}>
          {detail.checklist.map((item) => (
            <li data-complete={item.complete} key={item.key}>
              {item.complete ? "Concluído" : "Pendente"}: {checklistLabels[item.key]}
              {item.messages.length === 0 ? "" : ` — ${item.messages.join(" ")}`}
            </li>
          ))}
        </ul>
      </section>
      <div className={reviewStyles.comparisonGrid}>
        <StudioReviewRevisionPanel
          label={detail.reviewState === "reviewPending" ? "Versão candidata" : "Versão moderada"}
          loadMedia={interactive}
          onMediaStateChange={(key, state) =>
            setMediaStates((current) => recordMediaState(current, key, state))
          }
          previewExpiresAt={detail.previewExpiresAt}
          revision={detail.candidateRevision}
        />
        {detail.publishedRevision === null ||
        detail.publishedRevision.id === detail.candidateRevision.id ? null : (
          <StudioReviewRevisionPanel
            label="Versão pública vigente"
            loadMedia={interactive}
            onMediaStateChange={(key, state) =>
              setMediaStates((current) => recordMediaState(current, key, state))
            }
            previewExpiresAt={detail.previewExpiresAt}
            revision={detail.publishedRevision}
          />
        )}
      </div>
      {requiredPreviews.length > 0 && !previewsInspectable ? (
        <Alert
          title={
            previewExpired
              ? "As prévias expiraram"
              : previewFailed
                ? "Uma prévia não pôde ser inspecionada"
                : "Carregando prévias para inspeção"
          }
          variant={previewExpired || previewFailed ? "error" : "status"}
        >
          <p>
            {previewExpired || previewFailed
              ? "Nenhuma decisão pode ser enviada até que todas as imagens estejam novamente disponíveis."
              : "As decisões serão liberadas somente depois que todas as imagens carregarem por completo."}
          </p>
          {previewExpired || previewFailed ? (
            <div className={reviewStyles.actions}>
              <Button
                disabled={
                  !interactive ||
                  decision !== undefined ||
                  pendingSnapshot !== undefined ||
                  mutation.isPending ||
                  openingDecision !== undefined
                }
                onClick={() =>
                  void refreshAuthoritativeDetail(
                    "As prévias foram renovadas e o caso autoritativo foi confirmado.",
                  )
                }
                variant="secondary"
              >
                Renovar prévias
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}
      <section aria-labelledby="review-decision-title" className={reviewStyles.decisionPanel}>
        <h2 id="review-decision-title">Ação</h2>
        <div className={reviewStyles.decisionOptions}>
          {availableActions(detail).map((action) => (
            <Button
              disabled={decisionLocked}
              key={action}
              loading={openingDecision === action}
              loadingLabel="Confirmando estado"
              onClick={() => void beginDecision(action, snapshot)}
              ref={(element) => {
                actionButtons.current[action] = element;
              }}
              variant={action === "backoffice.studio.approve" ? "primary" : "secondary"}
            >
              {actionLabels[action]}
            </Button>
          ))}
        </div>
        {selectedAction === undefined || decision === undefined ? null : (
          <section
            aria-labelledby="review-confirmation-title"
            className={reviewStyles.section}
            ref={confirmationRef}
            tabIndex={-1}
          >
            <h3 id="review-confirmation-title">Confirmar impacto</h3>
            <p>{actionImpact(selectedAction, decision.detail)}</p>
            <dl className={reviewStyles.definitionList}>
              <dt>Estado revisado</dt>
              <dd>{studioStatusLabels[decision.detail.studioStatus]}</dd>
              <dt>Versão editorial revisada</dt>
              <dd>{decision.detail.publicationVersion}</dd>
              {selectedAction === "backoffice.studio.restore" &&
              decision.detail.disabledFromStatus !== null ? (
                <>
                  <dt>Destino exato</dt>
                  <dd>{studioStatusLabels[decision.detail.disabledFromStatus]}</dd>
                </>
              ) : null}
            </dl>
            {selectedAction === "backoffice.studio.reject" ? (
              <Field label="Motivo para o dono" required>
                <Textarea
                  disabled={mutation.isPending || retryAvailable}
                  maxLength={2_000}
                  onChange={(event) =>
                    setRejectionReason({ snapshot: decision.snapshot, value: event.target.value })
                  }
                  required
                  rows={5}
                  value={reason}
                />
              </Field>
            ) : null}
            <Checkbox
              checked={confirmed}
              disabled={mutation.isPending || retryAvailable || !previewsInspectable}
              label={actionAcknowledgement(decision.action)}
              onChange={(event) =>
                setConfirmedSnapshot(event.target.checked ? decision.snapshot : undefined)
              }
              required
            />
            {mutation.isError ? (
              <Alert variant="error">{studioReviewErrorMessage(mutation.error)}</Alert>
            ) : null}
            <div className={reviewStyles.actions}>
              <Button
                disabled={
                  mutation.isPending ||
                  (retryAvailable
                    ? pendingSnapshot === undefined
                    : !confirmed ||
                      !previewsInspectable ||
                      (selectedAction === "backoffice.studio.reject" && reason.trim() === ""))
                }
                loading={mutation.isPending}
                loadingLabel="Aplicando"
                onClick={() => {
                  if (pendingDecision.current === undefined) {
                    pendingDecision.current = {
                      command: commandForAction({
                        action: selectedAction,
                        detail: decision.detail,
                        reason,
                        scope: session.scope,
                      }),
                      snapshot: decision.snapshot,
                    };
                    setPendingSnapshot(decision.snapshot);
                  }
                  mutation.mutate();
                }}
                ref={submitButtonRef}
              >
                {retryAvailable ? "Repetir mesma tentativa" : "Confirmar ação"}
              </Button>
              <Button
                disabled={mutation.isPending || retryAvailable}
                onClick={() => {
                  returnFocusAction.current = selectedAction;
                  clearAttempt("decision");
                  mutation.reset();
                }}
                variant="ghost"
              >
                Cancelar
              </Button>
            </div>
          </section>
        )}
      </section>
      <div>
        <ButtonLink href="/estudios" variant="ghost">
          Voltar aos estúdios
        </ButtonLink>
      </div>
    </section>
  );
}
