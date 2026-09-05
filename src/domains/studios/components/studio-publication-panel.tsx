"use client";

import {
  formatStudioPostalCode,
  type StudioCommand,
  type StudioPublication,
  type StudioPublicationChecklistItem,
  type StudioPublicationRevisionPreview,
} from "@set-livre/contracts";
import { Alert, Button, Stack } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { useHydrated } from "@/lib/client/use-hydrated";

import {
  changeStudioPublication,
  isAmbiguousStudioError,
  isStudioBoundaryChangedError,
  readStudioPublication,
  StudioApiError,
} from "./studio-api";
import { StudioEditorNavigation } from "./studio-editor-navigation";
import {
  assertStudioPublicationBoundary,
  invalidateStudioPublicationDependents,
  isStudioPublicationBoundaryChangedError,
  preserveNewestStudioPublication,
  publishStudioPublication,
  recomposeStudioClientBoundary,
  studioPublicationCanRender,
  studioQueryKeys,
} from "./studio-query-keys";
import styles from "./studio-publication.module.css";

type StudioPublicationCommand = Extract<
  StudioCommand,
  { action: "studio.pause" | "studio.resume" | "studio.revision.submit" }
>;
type StudioPublicationAction = StudioPublicationCommand["action"];
type RecoveryState = Readonly<{
  action: StudioPublicationAction;
  kind: "ambiguous" | "conflict";
  phase: "error" | "reading" | "ready";
}>;
type Announcement = Readonly<{ sequence: number; text: string }>;
type CoverErrorState = Readonly<{ dataUpdatedAt: number; revisionIds: ReadonlySet<string> }>;

const checklistConfiguration = {
  content: { href: "dados", label: "Conteúdo comercial" },
  details: { href: "dados", label: "Dados do estúdio" },
  media: { href: "midia", label: "Fotos" },
} as const satisfies Record<
  StudioPublicationChecklistItem["key"],
  Readonly<{ href: "dados" | "midia"; label: string }>
>;

const studioStatusLabels: Readonly<Record<StudioPublication["studioStatus"], string>> = {
  changes_pending: "Publicado com alterações em revisão",
  disabled: "Desabilitado",
  draft: "Rascunho",
  paused: "Pausado",
  pending_review: "Em revisão",
  published: "Publicado",
  rejected: "Revisão rejeitada",
};

const revisionStatusLabels: Readonly<Record<StudioPublicationRevisionPreview["status"], string>> = {
  approved: "Aprovada",
  draft: "Rascunho editável",
  pending: "Pendente e imutável",
  rejected: "Rejeitada",
  superseded: "Substituída",
};

const actionLabels: Readonly<Record<StudioPublicationAction, string>> = {
  "studio.pause": "pausa",
  "studio.resume": "retomada",
  "studio.revision.submit": "envio para revisão",
};

function publicationCommand(
  action: StudioPublicationAction,
  publication: StudioPublication,
  userId: string,
  idempotencyKey: string,
): StudioPublicationCommand {
  if (action === "studio.revision.submit") {
    return {
      action,
      expectedScope: userId,
      idempotencyKey,
      payload: {
        expectedRevisionId: publication.currentRevision.id,
        expectedRevisionVersion: publication.currentRevision.version,
        studioId: publication.studioId,
      },
    };
  }
  return {
    action,
    expectedScope: userId,
    idempotencyKey,
    payload: {
      expectedPublicationVersion: publication.publicationVersion,
      studioId: publication.studioId,
    },
  };
}

function fullStudioAddress(revision: StudioPublicationRevisionPreview) {
  const complement = revision.addressComplement === null ? "" : `, ${revision.addressComplement}`;
  return `${revision.street}, ${revision.streetNumber}${complement} — ${revision.neighborhood}, ${revision.city}/${revision.state} — CEP ${formatStudioPostalCode(revision.postalCode)}`;
}

function formatReviewDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}

function actionSuccessMessage(action: StudioPublicationAction) {
  switch (action) {
    case "studio.pause":
      return "O estúdio foi pausado e o estado editorial foi registrado. Esta ação não altera reservas existentes.";
    case "studio.resume":
      return "O estúdio foi retomado conforme o estado editorial autoritativo.";
    case "studio.revision.submit":
      return "A revisão foi enviada uma vez e agora permanece imutável durante a análise.";
  }
}

function publicationSuccessMessage(
  action: StudioPublicationAction,
  commandResult: StudioPublication,
  retainedPublication: StudioPublication,
) {
  const commandResultWasRetained =
    commandResult.publicationVersion === retainedPublication.publicationVersion &&
    commandResult.currentRevision.id === retainedPublication.currentRevision.id &&
    commandResult.currentRevision.number === retainedPublication.currentRevision.number &&
    commandResult.currentRevision.version === retainedPublication.currentRevision.version;

  return commandResultWasRetained
    ? actionSuccessMessage(action)
    : `O estado mais recente da publicação foi preservado: ${studioStatusLabels[retainedPublication.studioStatus]}.`;
}

function publicationAllowsAction(publication: StudioPublication, action: StudioPublicationAction) {
  switch (action) {
    case "studio.pause":
      return publication.canPause;
    case "studio.resume":
      return publication.canResume;
    case "studio.revision.submit":
      return publication.canSubmit;
  }
}

function Checklist({
  items,
  studioId,
}: Readonly<{ items: StudioPublication["checklist"]; studioId: string }>) {
  return (
    <section aria-labelledby="publication-checklist-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <p className={styles.eyebrow}>Completude factual</p>
        <h2 className={styles.sectionTitle} id="publication-checklist-title">
          Checklist do anúncio
        </h2>
        <p>
          Cada pendência vem da leitura canônica. Corrija a seção indicada e volte para verificar.
        </p>
      </div>
      <ul className={styles.checklist}>
        {items.map((item) => {
          const configuration = checklistConfiguration[item.key];
          return (
            <li className={styles.checklistItem} key={item.key}>
              <span
                aria-hidden="true"
                className={item.complete ? styles.completeMark : styles.incompleteMark}
              >
                {item.complete ? "✓" : "!"}
              </span>
              <div className={styles.checklistContent}>
                <div className={styles.checklistHeading}>
                  <strong>{configuration.label}</strong>
                  <span>{item.complete ? "Completo" : "Precisa de atenção"}</span>
                </div>
                {item.messages.length === 0 ? (
                  <p>Nenhuma pendência encontrada nesta seção.</p>
                ) : (
                  <ul className={styles.pendingMessages}>
                    {item.messages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}
                <Link
                  className={styles.sectionLink}
                  href={`/dono/estudios/${studioId}/${configuration.href}`}
                >
                  {item.complete ? "Revisar seção" : "Corrigir seção"}
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RevisionPreview({
  coverError,
  kind,
  onCoverError,
  revision,
}: Readonly<{
  coverError: boolean;
  kind: "current" | "published";
  onCoverError: () => void;
  revision: StudioPublicationRevisionPreview;
}>) {
  const titleId = `${kind}-revision-title`;
  const label = kind === "current" ? "Versão atual do editor" : "Versão pública estável";
  return (
    <article aria-labelledby={titleId} className={styles.previewCard}>
      <header className={styles.previewHeader}>
        <div>
          <p className={styles.eyebrow}>{label}</p>
          <h3 className={styles.previewTitle} id={titleId}>
            {revision.name}
          </h3>
        </div>
        <span className={styles.revisionBadge}>{revisionStatusLabels[revision.status]}</span>
      </header>

      <div className={styles.coverFrame}>
        {revision.cover === null ? (
          <p className={styles.coverPlaceholder}>Nenhuma capa definida nesta revisão.</p>
        ) : coverError ? (
          <p className={styles.coverPlaceholder}>
            A prévia temporária da capa não pôde ser exibida.
          </p>
        ) : (
          <Image
            alt={`Capa de ${revision.name}`}
            className={styles.coverImage}
            height={revision.cover.height}
            onError={onCoverError}
            src={revision.cover.previewUrl}
            unoptimized
            width={revision.cover.width}
          />
        )}
      </div>

      <dl className={styles.facts}>
        <div>
          <dt>Revisão</dt>
          <dd>
            {revision.number}, versão {revision.version}
          </dd>
        </div>
        <div>
          <dt>Tipo</dt>
          <dd>{revision.studioType.name}</dd>
        </div>
        <div>
          <dt>Capacidade</dt>
          <dd>{revision.capacity} pessoas</dd>
        </div>
        <div>
          <dt>Fotos</dt>
          <dd>{revision.mediaCount}</dd>
        </div>
        <div>
          <dt>Vídeo</dt>
          <dd>{revision.youtubeVideoId === null ? "Não configurado" : "Configurado"}</dd>
        </div>
        <div>
          <dt>FAQ</dt>
          <dd>{revision.faqs.length} itens</dd>
        </div>
      </dl>

      <address className={styles.address}>{fullStudioAddress(revision)}</address>
      <p className={styles.description}>{revision.description}</p>

      <div className={styles.taxonomyFacts}>
        <div>
          <strong>Tags</strong>
          <p>
            {revision.tags.length === 0
              ? "Nenhuma"
              : revision.tags.map((tag) => tag.name).join(", ")}
          </p>
        </div>
        <div>
          <strong>Comodidades</strong>
          <p>
            {revision.amenities.length === 0
              ? "Nenhuma"
              : revision.amenities.map((amenity) => amenity.name).join(", ")}
          </p>
        </div>
      </div>

      <div className={styles.rulesPreview}>
        <strong>Regras de uso</strong>
        <p>{revision.usageRules.trim() === "" ? "Não informadas." : revision.usageRules}</p>
      </div>
    </article>
  );
}

function LatestReview({ review }: Readonly<{ review: StudioPublication["latestReview"] }>) {
  if (review === null) {
    return (
      <Alert title="Nenhum envio registrado">
        Quando uma revisão completa for enviada, o evento factual aparecerá aqui.
      </Alert>
    );
  }

  const title =
    review.eventType === "submitted"
      ? "Revisão enviada"
      : review.eventType === "approved"
        ? "Revisão aprovada"
        : "Revisão rejeitada";
  return (
    <Alert title={title} variant={review.eventType === "rejected" ? "error" : "status"}>
      <Stack space={2}>
        <span>Evento registrado em {formatReviewDate(review.occurredAt)}.</span>
        {review.rejectionReason === null ? null : (
          <span>
            <strong>Motivo:</strong> {review.rejectionReason}
          </span>
        )}
      </Stack>
    </Alert>
  );
}

function SafeVerificationState({
  error,
  onRead,
  onRetryExact,
  reading,
  recovery,
}: Readonly<{
  error: unknown;
  onRead: () => void;
  onRetryExact: (() => void) | undefined;
  reading: boolean;
  recovery: RecoveryState | undefined;
}>) {
  const title = reading
    ? "Verificando a publicação segura"
    : recovery?.kind === "conflict"
      ? "O estado precisa ser relido"
      : "Não foi possível verificar a publicação";
  return (
    <Alert title={title} variant={reading ? "status" : "error"}>
      <Stack space={3}>
        <span>
          {reading
            ? "Os dados privados e os controles permanecem ocultos até a confirmação autoritativa da sessão."
            : error instanceof StudioApiError
              ? error.message
              : "Nenhum dado privado foi exibido. Faça uma nova leitura antes de continuar."}
        </span>
        {reading ? null : (
          <div className={styles.compactActions}>
            <Button onClick={onRead} variant="secondary">
              Verificar estado atual
            </Button>
            {onRetryExact === undefined ? null : (
              <Button onClick={onRetryExact}>Repetir exatamente a mesma ação</Button>
            )}
          </div>
        )}
      </Stack>
    </Alert>
  );
}

function HydratedStudioPublicationPanel({
  initialPublication,
  userId,
}: Readonly<{ initialPublication: StudioPublication; userId: string }>) {
  const queryClient = useQueryClient();
  const studioId = initialPublication.studioId;
  const publicationQueryKey = useMemo(
    () => studioQueryKeys.publication(userId, studioId),
    [studioId, userId],
  );
  const [automaticRefetchLocked, setAutomaticRefetchLocked] = useState(false);
  const [activeAction, setActiveAction] = useState<StudioPublicationAction>();
  const [announcement, setAnnouncement] = useState<Announcement>();
  const [confirmPause, setConfirmPause] = useState(false);
  const [coverErrorState, setCoverErrorState] = useState<CoverErrorState>(() => ({
    dataUpdatedAt: 0,
    revisionIds: new Set(),
  }));
  const [recovery, setRecovery] = useState<RecoveryState>();
  const announcementReference = useRef<HTMLParagraphElement>(null);
  const pauseButtonReference = useRef<HTMLButtonElement>(null);
  const pauseConfirmationReference = useRef<HTMLHeadingElement>(null);
  const recoveryReference = useRef<HTMLDivElement>(null);
  const pendingCommand = useRef<StudioPublicationCommand | undefined>(undefined);
  const mutationInFlight = useRef(false);
  const recoveryReadInFlight = useRef(false);

  const publicationQuery = useQuery({
    initialData: initialPublication,
    queryFn: async ({ signal }) => {
      const candidate = assertStudioPublicationBoundary(
        await readStudioPublication(studioId, signal),
        userId,
        studioId,
      );
      return preserveNewestStudioPublication(
        queryClient.getQueryData<StudioPublication>(publicationQueryKey),
        candidate,
        userId,
        studioId,
      );
    },
    queryKey: publicationQueryKey,
    refetchOnMount: "always",
    refetchOnReconnect: automaticRefetchLocked ? false : "always",
    refetchOnWindowFocus: automaticRefetchLocked ? false : "always",
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (
      isStudioPublicationBoundaryChangedError(publicationQuery.error) ||
      isStudioBoundaryChangedError(publicationQuery.error)
    ) {
      recomposeStudioClientBoundary(queryClient);
    }
  }, [publicationQuery.error, queryClient]);

  useEffect(() => {
    if (announcement === undefined) return;
    const frame = requestAnimationFrame(() => announcementReference.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [announcement]);

  useEffect(() => {
    if (recovery === undefined) return;
    const frame = requestAnimationFrame(() => recoveryReference.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [recovery]);

  function announce(text: string) {
    setAnnouncement((current) => ({ sequence: (current?.sequence ?? 0) + 1, text }));
  }

  async function readForRecovery(state: Pick<RecoveryState, "action" | "kind">) {
    if (recoveryReadInFlight.current) return;
    recoveryReadInFlight.current = true;
    setRecovery({ ...state, phase: "reading" });
    try {
      const refreshed = await publicationQuery.refetch();
      setRecovery({ ...state, phase: refreshed.isSuccess ? "ready" : "error" });
    } finally {
      recoveryReadInFlight.current = false;
    }
  }

  const publicationMutation = useMutation({
    mutationFn: () => {
      if (pendingCommand.current === undefined) {
        throw new Error("A transição não possui solicitação idempotente preparada.");
      }
      return changeStudioPublication(pendingCommand.current);
    },
    networkMode: "always",
    onError: async (error) => {
      mutationInFlight.current = false;
      const failedAction = pendingCommand.current?.action;
      if (failedAction === undefined) {
        setActiveAction(undefined);
        setAutomaticRefetchLocked(false);
        return;
      }
      if (isAmbiguousStudioError(error)) return;
      pendingCommand.current = undefined;
      if (isStudioPublicationBoundaryChangedError(error) || isStudioBoundaryChangedError(error)) {
        recomposeStudioClientBoundary(queryClient);
        return;
      }
      if (
        error instanceof StudioApiError &&
        (error.code === "CONFLICT" || error.code === "STUDIO_SUBMISSION_INCOMPLETE")
      ) {
        setConfirmPause(false);
        await readForRecovery({ action: failedAction, kind: "conflict" });
        return;
      }
      setConfirmPause(false);
      setActiveAction(undefined);
      setAutomaticRefetchLocked(false);
    },
    onSuccess: async (publication) => {
      mutationInFlight.current = false;
      const completedAction = pendingCommand.current?.action;
      let retainedPublication: StudioPublication | undefined;
      pendingCommand.current = undefined;
      setActiveAction(undefined);
      setConfirmPause(false);
      setRecovery(undefined);
      try {
        await queryClient.cancelQueries({ exact: true, queryKey: publicationQueryKey });
        retainedPublication = publishStudioPublication(queryClient, publication, userId, studioId);
        await invalidateStudioPublicationDependents(queryClient, userId, studioId);
      } catch (error) {
        if (isStudioPublicationBoundaryChangedError(error)) {
          recomposeStudioClientBoundary(queryClient);
          return;
        }
        throw error;
      } finally {
        setAutomaticRefetchLocked(false);
      }
      if (completedAction !== undefined && retainedPublication !== undefined) {
        announce(publicationSuccessMessage(completedAction, publication, retainedPublication));
      }
    },
  });

  function beginAction(action: StudioPublicationAction, publication: StudioPublication) {
    if (
      pendingCommand.current !== undefined ||
      mutationInFlight.current ||
      automaticRefetchLocked ||
      !publicationAllowsAction(publication, action)
    ) {
      return;
    }
    publicationMutation.reset();
    setAnnouncement(undefined);
    setRecovery(undefined);
    pendingCommand.current = publicationCommand(action, publication, userId, crypto.randomUUID());
    mutationInFlight.current = true;
    setActiveAction(action);
    setAutomaticRefetchLocked(true);
    publicationMutation.mutate();
  }

  function retryExactCommand() {
    if (pendingCommand.current === undefined || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setRecovery(undefined);
    publicationMutation.mutate();
  }

  async function verifyAmbiguousCommand() {
    const action = pendingCommand.current?.action;
    if (action === undefined) return;
    await readForRecovery({ action, kind: "ambiguous" });
  }

  async function retryRecoveryRead() {
    if (recovery === undefined) {
      await publicationQuery.refetch();
      return;
    }
    await readForRecovery(recovery);
  }

  async function acceptAuthoritativeRecovery() {
    if (recovery?.phase !== "ready") return;
    await invalidateStudioPublicationDependents(queryClient, userId, studioId);
    pendingCommand.current = undefined;
    publicationMutation.reset();
    setActiveAction(undefined);
    setConfirmPause(false);
    setRecovery(undefined);
    setAutomaticRefetchLocked(false);
    announce(
      recovery.kind === "conflict"
        ? "O estado autoritativo foi carregado. Faça uma nova ação somente se ainda for necessária."
        : "O estado autoritativo foi carregado sem enviar um novo comando.",
    );
  }

  function openPauseConfirmation() {
    setConfirmPause(true);
    requestAnimationFrame(() => pauseConfirmationReference.current?.focus());
  }

  function closePauseConfirmation() {
    setConfirmPause(false);
    requestAnimationFrame(() => pauseButtonReference.current?.focus());
  }

  function markCoverError(revisionId: string) {
    setCoverErrorState((current) => ({
      dataUpdatedAt: publicationQuery.dataUpdatedAt,
      revisionIds: new Set([
        ...(current.dataUpdatedAt === publicationQuery.dataUpdatedAt ? current.revisionIds : []),
        revisionId,
      ]),
    }));
  }

  const ambiguousError = isAmbiguousStudioError(publicationMutation.error);
  const publicationVerified = studioPublicationCanRender(
    publicationQuery.data,
    userId,
    studioId,
    publicationQuery.fetchStatus,
    publicationQuery.isError,
  );

  if (!publicationVerified) {
    return (
      <SafeVerificationState
        error={publicationQuery.error}
        onRead={() => void retryRecoveryRead()}
        onRetryExact={ambiguousError ? retryExactCommand : undefined}
        reading={publicationQuery.fetchStatus === "fetching"}
        recovery={recovery}
      />
    );
  }

  const publication = assertStudioPublicationBoundary(publicationQuery.data, userId, studioId);
  const commandLocked =
    automaticRefetchLocked ||
    publicationMutation.isPending ||
    publicationQuery.fetchStatus !== "idle" ||
    recovery !== undefined;
  const mutationError =
    publicationMutation.error instanceof StudioApiError ? publicationMutation.error : undefined;
  const coverErrors =
    coverErrorState.dataUpdatedAt === publicationQuery.dataUpdatedAt
      ? coverErrorState.revisionIds
      : new Set<string>();

  return (
    <div className={styles.root}>
      <StudioEditorNavigation current="publicacao" studioId={studioId} />

      <section aria-labelledby="publication-status-title" className={styles.statusSection}>
        <div className={styles.statusHeading}>
          <div>
            <p className={styles.eyebrow}>Estado editorial</p>
            <h2 className={styles.sectionTitle} id="publication-status-title">
              {studioStatusLabels[publication.studioStatus]}
            </h2>
          </div>
          <span className={styles.versionBadge}>Versão {publication.publicationVersion}</span>
        </div>
        <LatestReview review={publication.latestReview} />
      </section>

      {announcement === undefined ? null : (
        <p
          aria-live="polite"
          className={styles.announcement}
          key={announcement.sequence}
          ref={announcementReference}
          role="status"
          tabIndex={-1}
        >
          {announcement.text}
        </p>
      )}

      {publication.currentRevision.status === "pending" ? (
        <Alert title="Revisão pendente e imutável">
          Conteúdo e fotos desta revisão não podem mudar durante a análise. Se já existir uma versão
          aprovada, ela permanece pública até uma nova decisão real da equipe Set Livre.
        </Alert>
      ) : null}

      {publication.studioStatus === "disabled" ? (
        <Alert title="Estúdio desabilitado" variant="error">
          O estado administrativo bloqueia transições do dono. Esta página permanece apenas para
          consulta factual.
        </Alert>
      ) : null}

      {coverErrors.size === 0 ? null : (
        <Alert title="Uma capa temporária não pôde ser exibida" variant="error">
          <Stack space={3}>
            <span>Faça uma nova leitura para renovar as URLs assinadas das prévias privadas.</span>
            <Button
              disabled={commandLocked}
              onClick={() => void publicationQuery.refetch()}
              variant="secondary"
            >
              Renovar prévias
            </Button>
          </Stack>
        </Alert>
      )}

      {recovery === undefined && ambiguousError ? (
        <Alert title="A resposta não confirmou a ação" variant="error">
          <Stack space={3}>
            <span>
              {mutationError?.message ??
                "A ação pode ou não ter sido aplicada. Nenhuma nova transição será criada até a verificação."}
            </span>
            <div className={styles.compactActions}>
              <Button onClick={() => void verifyAmbiguousCommand()} variant="secondary">
                Verificar estado atual
              </Button>
              <Button onClick={retryExactCommand}>Repetir exatamente a mesma ação</Button>
            </div>
          </Stack>
        </Alert>
      ) : recovery === undefined ? null : (
        <div aria-label="Recuperação segura da publicação" ref={recoveryReference} tabIndex={-1}>
          <Alert
            title={
              recovery.kind === "conflict"
                ? "O estado mudou antes da ação"
                : "Verificação da ação ambígua"
            }
            variant={recovery.phase === "ready" ? "status" : "error"}
          >
            <Stack space={3}>
              <span>
                {recovery.phase === "reading"
                  ? `Lendo a publicação autoritativa após a ${actionLabels[recovery.action]} antes de liberar qualquer nova ação.`
                  : recovery.phase === "error"
                    ? recovery.kind === "ambiguous"
                      ? "A releitura falhou. Os controles continuam bloqueados e o mesmo comando idempotente permanece disponível para retry."
                      : "A releitura falhou. Os controles continuam bloqueados e o comando conflitante não será repetido."
                    : "A leitura autoritativa terminou. Confirme o estado lido antes de iniciar outra ação."}
              </span>
              {recovery.phase === "error" ? (
                <Button onClick={() => void retryRecoveryRead()} variant="secondary">
                  Verificar novamente
                </Button>
              ) : recovery.phase === "ready" ? (
                <div className={styles.compactActions}>
                  <Button onClick={() => void acceptAuthoritativeRecovery()} variant="secondary">
                    Usar estado autoritativo
                  </Button>
                  {recovery.kind === "ambiguous" ? (
                    <Button onClick={retryExactCommand}>Repetir exatamente a mesma ação</Button>
                  ) : null}
                </div>
              ) : null}
            </Stack>
          </Alert>
        </div>
      )}

      {mutationError !== undefined && !ambiguousError && recovery === undefined ? (
        <Alert title="Não foi possível concluir a ação" variant="error">
          {mutationError.message}
        </Alert>
      ) : null}

      <Checklist items={publication.checklist} studioId={studioId} />

      <section aria-labelledby="publication-previews-title" className={styles.section}>
        <div className={styles.sectionHeader}>
          <p className={styles.eyebrow}>Comparação privada</p>
          <h2 className={styles.sectionTitle} id="publication-previews-title">
            Prévia das revisões
          </h2>
          <p>
            A versão atual pode estar em edição ou análise. A versão pública só muda após uma
            aprovação real.
          </p>
        </div>
        <div className={styles.previewGrid}>
          <RevisionPreview
            coverError={coverErrors.has(publication.currentRevision.id)}
            kind="current"
            onCoverError={() => markCoverError(publication.currentRevision.id)}
            revision={publication.currentRevision}
          />
          {publication.publishedRevision === null ? (
            <section aria-labelledby="no-public-revision-title" className={styles.emptyPreview}>
              <p className={styles.eyebrow}>Versão pública estável</p>
              <h3 className={styles.previewTitle} id="no-public-revision-title">
                Ainda não existe publicação aprovada
              </h3>
              <p>O anúncio só ficará público depois que a equipe Set Livre concluir a revisão.</p>
            </section>
          ) : (
            <RevisionPreview
              coverError={coverErrors.has(publication.publishedRevision.id)}
              kind="published"
              onCoverError={() => markCoverError(publication.publishedRevision?.id ?? "")}
              revision={publication.publishedRevision}
            />
          )}
        </div>
      </section>

      <section aria-labelledby="publication-actions-title" className={styles.actionSection}>
        <div className={styles.sectionHeader}>
          <p className={styles.eyebrow}>Transições disponíveis</p>
          <h2 className={styles.sectionTitle} id="publication-actions-title">
            Ações do dono
          </h2>
          <p>
            Esta tela não aprova nem rejeita anúncios. Ela oferece somente as transições autorizadas
            pelo estado canônico atual.
          </p>
        </div>

        {confirmPause && publication.canPause ? (
          <div className={styles.pauseConfirmation}>
            <h3 ref={pauseConfirmationReference} tabIndex={-1}>
              Confirmar pausa do estúdio
            </h3>
            <p>
              A pausa registra o estado que as superfícies públicas e de checkout usarão para
              impedir novas reservas. Esta ação não cancela reservas existentes, e a versão aprovada
              será preservada para uma retomada elegível.
            </p>
            <div className={styles.compactActions}>
              <Button
                disabled={commandLocked}
                loading={publicationMutation.isPending}
                loadingLabel="Pausando estúdio"
                onClick={() => beginAction("studio.pause", publication)}
              >
                Confirmar pausa
              </Button>
              <Button disabled={commandLocked} onClick={closePauseConfirmation} variant="secondary">
                Manter estúdio ativo
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.actions}>
            {publication.canSubmit ? (
              <Button
                disabled={commandLocked}
                loading={publicationMutation.isPending && activeAction === "studio.revision.submit"}
                loadingLabel="Enviando para revisão"
                onClick={() => beginAction("studio.revision.submit", publication)}
              >
                Enviar revisão completa
              </Button>
            ) : null}
            {publication.canPause ? (
              <Button
                disabled={commandLocked}
                onClick={openPauseConfirmation}
                ref={pauseButtonReference}
                variant="secondary"
              >
                Pausar estúdio
              </Button>
            ) : null}
            {publication.canResume ? (
              <Button
                disabled={commandLocked}
                loading={publicationMutation.isPending && activeAction === "studio.resume"}
                loadingLabel="Retomando estúdio"
                onClick={() => beginAction("studio.resume", publication)}
              >
                Retomar estúdio
              </Button>
            ) : null}
            {!publication.canSubmit && !publication.canPause && !publication.canResume ? (
              <p className={styles.noActions}>
                Nenhuma transição do dono está disponível neste estado.
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

export function StudioPublicationPanel({
  initialPublication,
  userId,
}: Readonly<{ initialPublication: StudioPublication; userId: string }>) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <>
        <Alert title="Preparando a publicação segura" variant="status">
          Aguarde enquanto conectamos os controles privados desta página.
        </Alert>
      </>
    );
  }
  return <HydratedStudioPublicationPanel initialPublication={initialPublication} userId={userId} />;
}
