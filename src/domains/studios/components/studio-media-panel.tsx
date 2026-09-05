"use client";

import {
  studioMediaMaximumBytes,
  studioMediaMaximumFiles,
  studioMediaGallerySchema,
  studioMediaMimeTypeSchema,
  type StudioMediaCommand,
  type StudioMediaGallery,
  type StudioMediaUploadPreparation,
} from "@set-livre/contracts";
import { Alert, Button, Stack } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { useHydrated } from "@/lib/client/use-hydrated";

import {
  deleteStudioMedia,
  finalizeStudioMediaUpload,
  isAmbiguousStudioError,
  isStudioBoundaryChangedError,
  prepareStudioMediaUpload,
  readStudioMedia,
  reorderStudioMedia,
  setStudioMediaCover,
  StudioApiError,
  uploadStudioMediaObject,
} from "./studio-api";
import { StudioEditorNavigation } from "./studio-editor-navigation";
import {
  assertStudioMediaBoundary,
  preserveNewestStudioMediaGallery,
  publishAuthoritativeStudioMediaGallery,
  publishStudioMediaGallery,
  recomposeStudioClientBoundary,
  studioMediaOrderMatchesIntent,
  StudioMediaScopeChangedError,
  studioQueryKeys,
} from "./studio-query-keys";
import styles from "./studio-media.module.css";

type MediaItem = StudioMediaGallery["items"][number];
type PrepareCommand = Extract<StudioMediaCommand, { action: "studio.media.upload.prepare" }>;
type FinalizeCommand = Extract<StudioMediaCommand, { action: "studio.media.upload.finalize" }>;
type GalleryCommand = Extract<
  StudioMediaCommand,
  {
    action: "studio.media.cover.set" | "studio.media.delete" | "studio.media.reorder";
  }
>;

type UploadPhase =
  "ambiguous" | "complete" | "error" | "finalizing" | "preparing" | "queued" | "uploading";

type UploadAttempt = Readonly<{
  fileName: string;
  id: string;
  message: string;
  phase: UploadPhase;
  retry: "exact" | "renew" | "verify" | undefined;
}>;

type UploadRuntime = {
  file: File;
  finalizeCommand?: FinalizeCommand;
  preparation?: StudioMediaUploadPreparation;
  prepareCommand?: PrepareCommand;
  uploadConfirmed?: boolean;
};

type UploadQueueOutcome = "blocked" | "continue";

type GalleryOperation = Readonly<{
  command: GalleryCommand;
  focusFilePicker?: boolean;
  focusMediaId?: string;
  kind: "capa" | "exclusão" | "ordem";
}>;

type GalleryOperationState = Readonly<{
  canRetry: boolean;
  message: string;
  status: "ambiguous" | "error" | "pending";
}>;

type ConflictState = Readonly<{
  kind: string;
  local: StudioMediaGallery;
  remote?: StudioMediaGallery;
  status: "error" | "loading" | "ready";
}>;

function errorMessage(error: unknown) {
  return error instanceof StudioApiError
    ? error.message
    : "Não foi possível concluir esta ação. Verifique o estado antes de repetir.";
}

function isConflictError(error: unknown) {
  return error instanceof StudioApiError && error.code === "CONFLICT";
}

function galleryCommandLabel(command: GalleryCommand) {
  switch (command.action) {
    case "studio.media.cover.set":
      return "Alterando capa";
    case "studio.media.delete":
      return "Excluindo foto";
    case "studio.media.reorder":
      return "Salvando ordem";
  }
}

function galleryIntentIsConfirmed(operation: GalleryOperation, gallery: StudioMediaGallery) {
  const command = operation.command;
  switch (command.action) {
    case "studio.media.cover.set":
      return gallery.items.some((item) => item.id === command.payload.mediaId && item.isCover);
    case "studio.media.delete":
      return gallery.items.every((item) => item.id !== command.payload.mediaId);
    case "studio.media.reorder":
      return studioMediaOrderMatchesIntent(gallery.items, command.payload.orderedMediaIds);
  }
}

function formatFileSize(bytes: number) {
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: bytes >= 1024 * 1024 ? "megabyte" : "kilobyte",
    unitDisplay: "short",
  }).format(bytes / (bytes >= 1024 * 1024 ? 1024 * 1024 : 1024));
}

function MediaLightbox({
  item,
  items,
  onNavigate,
  onPreviewExpired,
  onRefresh,
  onRequestClose,
  openerReference,
  previewExpired,
  readOnly,
}: Readonly<{
  item: MediaItem;
  items: readonly MediaItem[];
  onNavigate: (mediaId: string) => void;
  onPreviewExpired: (mediaId: string) => void;
  onRefresh: () => void;
  onRequestClose: () => void;
  openerReference: RefObject<HTMLElement | null>;
  previewExpired: boolean;
  readOnly: boolean;
}>) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const index = items.findIndex((candidate) => candidate.id === item.id);

  useEffect(() => {
    const dialog = dialogReference.current;
    const opener = openerReference.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog?.open === true) dialog.close();
      opener?.focus();
    };
  }, [openerReference]);

  function navigate(offset: number) {
    const nextIndex = (index + offset + items.length) % items.length;
    const next = items[nextIndex];
    if (next !== undefined) onNavigate(next.id);
  }

  function handleKeyboard(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigate(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      navigate(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = items.at(0);
      if (first !== undefined) onNavigate(first.id);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = items.at(-1);
      if (last !== undefined) onNavigate(last.id);
    }
  }

  return (
    <dialog
      aria-labelledby="studio-media-lightbox-title"
      className={styles.lightbox}
      onCancel={(event) => {
        event.preventDefault();
        onRequestClose();
      }}
      onKeyDown={handleKeyboard}
      ref={dialogReference}
    >
      <div className={styles.lightboxHeader}>
        <div>
          <h2 className={styles.lightboxTitle} id="studio-media-lightbox-title">
            Foto {index + 1} de {items.length}
          </h2>
          <p className={styles.lightboxMeta}>
            {item.isCover
              ? readOnly
                ? "Capa enviada para análise"
                : "Capa do rascunho"
              : readOnly
                ? "Foto enviada para análise"
                : "Foto privada"}
          </p>
        </div>
        <Button onClick={onRequestClose} variant="secondary">
          Fechar visualização
        </Button>
      </div>

      {previewExpired ? (
        <Alert title="A prévia privada expirou" variant="error">
          <Stack space={3}>
            <span>Atualize a galeria para solicitar uma nova URL temporária.</span>
            <Button
              onClick={() => {
                onRequestClose();
                onRefresh();
              }}
              variant="secondary"
            >
              Atualizar fotos
            </Button>
          </Stack>
        </Alert>
      ) : (
        <div className={styles.lightboxImageFrame}>
          <Image
            alt={`Foto ${item.position} do estúdio${item.isCover ? ", capa do rascunho" : ""}`}
            className={styles.lightboxImage}
            height={item.height}
            onError={() => onPreviewExpired(item.id)}
            priority
            sizes="100vw"
            src={item.previewUrl}
            unoptimized
            width={item.width}
          />
        </div>
      )}

      {items.length > 1 ? (
        <div className={styles.lightboxActions}>
          <Button onClick={() => navigate(-1)} variant="secondary">
            Foto anterior
          </Button>
          <Button onClick={() => navigate(1)} variant="secondary">
            Próxima foto
          </Button>
        </div>
      ) : null}
    </dialog>
  );
}

function HydratedStudioMediaPanel({
  studioId,
  userId,
}: Readonly<{ studioId: string; userId: string }>) {
  const queryClient = useQueryClient();
  const mediaQueryKey = useMemo(() => studioQueryKeys.media(userId, studioId), [studioId, userId]);
  const [announcement, setAnnouncement] = useState<
    Readonly<{
      sequence: number;
      text: string;
    }>
  >();
  const [attempts, setAttemptsState] = useState<readonly UploadAttempt[]>([]);
  const [conflict, setConflict] = useState<ConflictState>();
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string>();
  const [expiredPreviewIds, setExpiredPreviewIds] = useState<ReadonlySet<string>>(new Set());
  const [galleryOperation, setGalleryOperation] = useState<GalleryOperationState>();
  const [lightboxId, setLightboxId] = useState<string>();
  const [queueRunning, setQueueRunning] = useState(false);
  const announcementSequenceReference = useRef(0);
  const attemptsReference = useRef<readonly UploadAttempt[]>([]);
  const deleteButtonReferences = useRef(new Map<string, HTMLButtonElement>());
  const filePickerReference = useRef<HTMLInputElement>(null);
  const expiredPreviewIdsReference = useRef(new Set<string>());
  const galleryOperationReference = useRef<GalleryOperation | undefined>(undefined);
  const galleryReference = useRef<StudioMediaGallery | undefined>(undefined);
  const lightboxOpenerReference = useRef<HTMLElement | null>(null);
  const queueRunningReference = useRef(false);
  const thumbnailReferences = useRef(new Map<string, HTMLButtonElement>());
  const uploadAbortReference = useRef<AbortController | undefined>(undefined);
  const uploadRuntimeReference = useRef(new Map<string, UploadRuntime>());
  const queryCanRefetch = conflict === undefined && galleryOperation === undefined && !queueRunning;
  const mediaQuery = useQuery({
    networkMode: "always",
    queryFn: async ({ signal }) =>
      assertStudioMediaBoundary(await readStudioMedia(studioId, signal), userId, studioId),
    queryKey: mediaQueryKey,
    refetchOnMount: "always",
    refetchOnReconnect: queryCanRefetch ? "always" : false,
    refetchOnWindowFocus: queryCanRefetch ? "always" : false,
    retry: false,
    staleTime: 0,
    structuralSharing: (current, candidate) =>
      preserveNewestStudioMediaGallery(
        current === undefined ? undefined : studioMediaGallerySchema.parse(current),
        studioMediaGallerySchema.parse(candidate),
        userId,
        studioId,
      ),
  });
  const prepareMutation = useMutation({
    mutationFn: prepareStudioMediaUpload,
    networkMode: "always",
    retry: false,
  });
  const finalizeMutation = useMutation({
    mutationFn: finalizeStudioMediaUpload,
    networkMode: "always",
    retry: false,
  });
  const galleryMutation = useMutation({
    mutationFn: (command: GalleryCommand) => {
      switch (command.action) {
        case "studio.media.cover.set":
          return setStudioMediaCover(command);
        case "studio.media.delete":
          return deleteStudioMedia(command);
        case "studio.media.reorder":
          return reorderStudioMedia(command);
      }
    },
    networkMode: "always",
    retry: false,
  });

  function announce(text: string) {
    announcementSequenceReference.current += 1;
    setAnnouncement({ sequence: announcementSequenceReference.current, text });
  }

  function replaceAttempts(
    update: (current: readonly UploadAttempt[]) => readonly UploadAttempt[],
  ) {
    const next = update(attemptsReference.current);
    attemptsReference.current = next;
    setAttemptsState(next);
  }

  function updateAttempt(id: string, patch: Partial<Omit<UploadAttempt, "id">>) {
    replaceAttempts((current) =>
      current.map((attempt) => (attempt.id === id ? { ...attempt, ...patch } : attempt)),
    );
  }

  useEffect(() => {
    const gallery = mediaQuery.data;
    if (gallery !== undefined) galleryReference.current = gallery;
  }, [mediaQuery.data]);

  useEffect(() => {
    const error = mediaQuery.error;
    if (error instanceof StudioMediaScopeChangedError || isStudioBoundaryChangedError(error)) {
      uploadAbortReference.current?.abort();
      uploadRuntimeReference.current.clear();
      recomposeStudioClientBoundary(queryClient);
    }
  }, [mediaQuery.error, queryClient]);

  useEffect(
    () => () => {
      uploadAbortReference.current?.abort();
      uploadRuntimeReference.current.clear();
    },
    [],
  );

  function boundaryChanged(error: unknown) {
    if (error instanceof StudioMediaScopeChangedError || isStudioBoundaryChangedError(error)) {
      uploadAbortReference.current?.abort();
      uploadRuntimeReference.current.clear();
      recomposeStudioClientBoundary(queryClient);
      return true;
    }
    return false;
  }

  async function publishGallery(
    gallery: StudioMediaGallery,
    focusMediaId?: string,
    focusFilePicker = false,
    source: "authoritative-read" | "command-result" = "command-result",
  ) {
    const scoped = assertStudioMediaBoundary(gallery, userId, studioId);
    await queryClient.cancelQueries({ exact: true, queryKey: mediaQueryKey });
    const selected =
      source === "authoritative-read"
        ? publishAuthoritativeStudioMediaGallery(queryClient, scoped, userId, studioId)
        : publishStudioMediaGallery(queryClient, scoped, userId, studioId);
    galleryReference.current = selected;
    expiredPreviewIdsReference.current.clear();
    setExpiredPreviewIds(new Set());
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: studioQueryKeys.editor(userId, studioId),
    });
    if (focusMediaId !== undefined || focusFilePicker) {
      requestAnimationFrame(() => {
        if (focusMediaId !== undefined) thumbnailReferences.current.get(focusMediaId)?.focus();
        else filePickerReference.current?.focus();
      });
    }
    return selected;
  }

  async function refreshAuthoritativeGallery(focusMediaId?: string, focusFilePicker = false) {
    return publishGallery(
      assertStudioMediaBoundary(await readStudioMedia(studioId), userId, studioId),
      focusMediaId,
      focusFilePicker,
      "authoritative-read",
    );
  }

  async function recoverConflict(kind: string, local: StudioMediaGallery) {
    setDeleteConfirmationId(undefined);
    setConflict({ kind, local, status: "loading" });
    const refreshed = await mediaQuery.refetch();
    if (refreshed.isSuccess) {
      try {
        const remote = assertStudioMediaBoundary(refreshed.data, userId, studioId);
        setConflict({ kind, local, remote, status: "ready" });
      } catch (error) {
        if (!boundaryChanged(error)) setConflict({ kind, local, status: "error" });
      }
      return;
    }
    if (!boundaryChanged(refreshed.error)) setConflict({ kind, local, status: "error" });
  }

  function resetUploadReservation(runtime: UploadRuntime) {
    delete runtime.preparation;
    delete runtime.prepareCommand;
    delete runtime.finalizeCommand;
    runtime.uploadConfirmed = false;
  }

  function ensureFinalizeCommand(runtime: UploadRuntime) {
    const preparation = runtime.preparation;
    if (preparation === undefined) return undefined;
    runtime.finalizeCommand ??= {
      action: "studio.media.upload.finalize",
      expectedScope: userId,
      idempotencyKey: crypto.randomUUID(),
      payload: {
        expectedRevisionId: preparation.revisionId,
        expectedRevisionVersion: preparation.revisionVersion,
        mediaId: preparation.mediaId,
        studioId,
      },
    };
    return runtime.finalizeCommand;
  }

  async function handleUploadError(
    id: string,
    error: unknown,
    stage: string,
  ): Promise<UploadQueueOutcome> {
    if (boundaryChanged(error)) return "blocked";
    const local = galleryReference.current;
    const runtime = uploadRuntimeReference.current.get(id);
    if (isConflictError(error) && local !== undefined) {
      if (stage === "preparo" && runtime !== undefined) {
        const finalizeCommand = ensureFinalizeCommand(runtime);
        if (finalizeCommand !== undefined) {
          try {
            const finalized = await finalizeMutation.mutateAsync(finalizeCommand);
            return finishUpload(id, finalizeCommand.payload.mediaId, finalized);
          } catch (settlementError) {
            if (boundaryChanged(settlementError)) return "blocked";
            if (!isConflictError(settlementError)) {
              updateAttempt(id, {
                message:
                  "A galeria mudou, mas a liberação da reserva ainda não foi confirmada. Verifique o estado antes de renovar.",
                phase: "ambiguous",
                retry: "verify",
              });
              await recoverConflict(`upload (${stage})`, local);
              return "blocked";
            }
          }
        }
      }
      if (runtime !== undefined) resetUploadReservation(runtime);
      updateAttempt(id, {
        message: "A galeria mudou durante esta tentativa. Aceite a versão salva e renove o envio.",
        phase: "error",
        retry: "renew",
      });
      await recoverConflict(`upload (${stage})`, local);
      return "blocked";
    }
    const uploadRejected =
      error instanceof StudioApiError && error.code === "STORAGE_UPLOAD_REJECTED";
    const objectMissing = error instanceof StudioApiError && error.code === "UPLOAD_OBJECT_MISSING";
    const uploadExpired = error instanceof StudioApiError && error.code === "UPLOAD_EXPIRED";
    const renewalRequired = objectMissing || uploadExpired;
    if (renewalRequired && runtime !== undefined) resetUploadReservation(runtime);
    const ambiguous =
      !renewalRequired && (uploadRejected || stage === "envio" || isAmbiguousStudioError(error));
    const validationRejected =
      error instanceof StudioApiError && error.code === "VALIDATION_FAILED";
    if (validationRejected) uploadRuntimeReference.current.delete(id);
    updateAttempt(id, {
      message: ambiguous
        ? "O resultado não foi confirmado. Verifique o estado atual antes de repetir qualquer etapa."
        : renewalRequired
          ? `${errorMessage(error)} Uma nova reserva usará outra identidade e outro token.`
          : errorMessage(error),
      phase: ambiguous ? "ambiguous" : "error",
      retry: ambiguous
        ? "verify"
        : renewalRequired
          ? "renew"
          : validationRejected
            ? undefined
            : "exact",
    });
    return ambiguous ? "blocked" : "continue";
  }

  async function finishUpload(
    id: string,
    mediaId: string,
    authoritativeGallery?: StudioMediaGallery,
  ): Promise<UploadQueueOutcome> {
    const gallery =
      authoritativeGallery === undefined
        ? await refreshAuthoritativeGallery()
        : await publishGallery(authoritativeGallery);
    if (!gallery.items.some((item) => item.id === mediaId)) {
      const runtime = uploadRuntimeReference.current.get(id);
      if (runtime !== undefined) resetUploadReservation(runtime);
      updateAttempt(id, {
        message:
          "A solicitação antiga foi reconhecida, mas a galeria já avançou. Renove o envio para criar uma nova ação.",
        phase: "error",
        retry: "renew",
      });
      return "continue";
    }
    const runtime = uploadRuntimeReference.current.get(id);
    const fileName = runtime?.file.name ?? "selecionada";
    updateAttempt(id, {
      message: "Foto verificada e adicionada ao rascunho.",
      phase: "complete",
      retry: undefined,
    });
    uploadRuntimeReference.current.delete(id);
    announce(`Foto ${fileName} adicionada à galeria privada.`);
    return "continue";
  }

  async function runUploadAttempt(id: string): Promise<UploadQueueOutcome> {
    const runtime = uploadRuntimeReference.current.get(id);
    const gallery = galleryReference.current;
    if (runtime === undefined || gallery === undefined) return "blocked";
    const controller = new AbortController();
    uploadAbortReference.current = controller;

    try {
      if (runtime.preparation === undefined) {
        runtime.prepareCommand ??= {
          action: "studio.media.upload.prepare",
          expectedScope: userId,
          idempotencyKey: crypto.randomUUID(),
          payload: {
            declaredByteSize: runtime.file.size,
            declaredChecksumSha256: null,
            declaredMimeType: studioMediaMimeTypeSchema.parse(runtime.file.type),
            expectedRevisionId: gallery.revisionId,
            expectedRevisionVersion: gallery.revisionVersion,
            studioId,
          },
        };
        updateAttempt(id, {
          message: "Preparando o envio privado.",
          phase: "preparing",
          retry: undefined,
        });
        try {
          runtime.preparation = await prepareMutation.mutateAsync(runtime.prepareCommand);
          ensureFinalizeCommand(runtime);
          const preparedGallery = await refreshAuthoritativeGallery();
          if (
            preparedGallery.revisionId !== runtime.preparation.revisionId ||
            preparedGallery.revisionVersion !== runtime.preparation.revisionVersion
          ) {
            throw new StudioApiError(
              "CONFLICT",
              "A galeria mudou depois que o envio foi preparado.",
            );
          }
        } catch (error) {
          return handleUploadError(id, error, "preparo");
        }
      }

      const finalizeCommand = ensureFinalizeCommand(runtime);
      if (finalizeCommand === undefined) return "blocked";

      if (runtime.uploadConfirmed !== true) {
        updateAttempt(id, {
          message: "Enviando o arquivo diretamente ao armazenamento privado.",
          phase: "uploading",
          retry: undefined,
        });
        try {
          await uploadStudioMediaObject(runtime.preparation, runtime.file, controller.signal);
          runtime.uploadConfirmed = true;
        } catch (error) {
          if (error instanceof StudioApiError && error.code === "STORAGE_UPLOAD_REJECTED") {
            updateAttempt(id, {
              message:
                "O armazenamento recusou o envio. Confirmando no servidor antes de liberar a reserva.",
              phase: "finalizing",
              retry: undefined,
            });
            try {
              const finalized = await finalizeMutation.mutateAsync(finalizeCommand);
              return await finishUpload(id, runtime.preparation.mediaId, finalized);
            } catch (settlementError) {
              return handleUploadError(id, settlementError, "verificação");
            }
          }
          return handleUploadError(id, error, "envio");
        }
      }

      updateAttempt(id, {
        message: "Verificando tipo, tamanho e conteúdo no servidor.",
        phase: "finalizing",
        retry: undefined,
      });
      try {
        const finalized = await finalizeMutation.mutateAsync(finalizeCommand);
        return await finishUpload(id, runtime.preparation.mediaId, finalized);
      } catch (error) {
        return handleUploadError(id, error, "verificação");
      }
    } finally {
      if (uploadAbortReference.current === controller) uploadAbortReference.current = undefined;
    }
  }

  async function processUploadQueue(ids: readonly string[]) {
    if (queueRunningReference.current) return;
    queueRunningReference.current = true;
    setQueueRunning(true);
    try {
      for (const id of ids) {
        if ((await runUploadAttempt(id)) === "blocked") break;
      }
    } finally {
      queueRunningReference.current = false;
      setQueueRunning(false);
    }
  }

  function queuedUploadIds(excludedId: string) {
    return attemptsReference.current
      .filter((attempt) => attempt.phase === "queued" && attempt.id !== excludedId)
      .map((attempt) => attempt.id);
  }

  function retryUpload(id: string, renew = false) {
    const runtime = uploadRuntimeReference.current.get(id);
    if (renew && runtime !== undefined) resetUploadReservation(runtime);
    updateAttempt(id, {
      message: renew ? "Criando uma nova reserva de upload." : "Tentativa retomada.",
      phase: "queued",
      retry: undefined,
    });
    void processUploadQueue([id, ...queuedUploadIds(id)]);
  }

  async function verifyUpload(id: string) {
    if (queueRunningReference.current) return;
    queueRunningReference.current = true;
    setQueueRunning(true);
    const runtime = uploadRuntimeReference.current.get(id);
    let outcome: UploadQueueOutcome = "blocked";
    try {
      updateAttempt(id, {
        message: "Consultando a galeria canônica antes de qualquer repetição.",
        phase: "finalizing",
        retry: undefined,
      });
      const refreshed = await mediaQuery.refetch();
      if (!refreshed.isSuccess) {
        outcome = await handleUploadError(id, refreshed.error, "consulta");
        return;
      }
      const gallery = assertStudioMediaBoundary(refreshed.data, userId, studioId);
      const mediaId = runtime?.preparation?.mediaId;
      if (mediaId !== undefined && gallery.items.some((item) => item.id === mediaId)) {
        outcome = await finishUpload(id, mediaId, gallery);
        return;
      }
      if (runtime?.finalizeCommand !== undefined) {
        try {
          await finalizeMutation.mutateAsync(runtime.finalizeCommand);
          outcome = await finishUpload(id, runtime.finalizeCommand.payload.mediaId);
          return;
        } catch (error) {
          outcome = await handleUploadError(id, error, "verificação");
          return;
        }
      }
      updateAttempt(id, {
        message:
          "A preparação não foi confirmada. Você pode repetir exatamente a mesma solicitação.",
        phase: "error",
        retry: "exact",
      });
      outcome = "continue";
    } catch (error) {
      outcome = await handleUploadError(id, error, "consulta");
    } finally {
      queueRunningReference.current = false;
      setQueueRunning(false);
      if (outcome === "continue") {
        const queued = queuedUploadIds(id);
        if (queued.length > 0) void processUploadQueue(queued);
      }
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const gallery = galleryReference.current;
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (gallery === undefined || files.length === 0) return;

    let available = studioMediaMaximumFiles - gallery.items.length;
    const nextAttempts: UploadAttempt[] = [];
    const queuedIds: string[] = [];
    for (const file of files) {
      const id = crypto.randomUUID();
      const validMime = studioMediaMimeTypeSchema.safeParse(file.type).success;
      let message: string | undefined;
      if (!validMime) {
        message = "Use uma foto JPEG, PNG, WebP ou AVIF.";
      } else if (file.size < 1) {
        message = "A foto está vazia.";
      } else if (file.size > studioMediaMaximumBytes) {
        message = "Cada foto pode ter no máximo 15 MB.";
      } else if (available < 1) {
        message = "O rascunho já atingiu o limite de 20 fotos.";
      }

      if (message !== undefined) {
        nextAttempts.push({ fileName: file.name, id, message, phase: "error", retry: undefined });
        continue;
      }
      available -= 1;
      uploadRuntimeReference.current.set(id, { file });
      nextAttempts.push({
        fileName: file.name,
        id,
        message: `Na fila · ${formatFileSize(file.size)}`,
        phase: "queued",
        retry: undefined,
      });
      queuedIds.push(id);
    }
    replaceAttempts((current) => [...current, ...nextAttempts]);
    if (queuedIds.length > 0) void processUploadQueue(queuedIds);
  }

  async function executeGalleryOperation(operation: GalleryOperation) {
    galleryOperationReference.current = operation;
    setGalleryOperation({
      canRetry: false,
      message: `${galleryCommandLabel(operation.command)} na versão canônica.`,
      status: "pending",
    });
    try {
      await galleryMutation.mutateAsync(operation.command);
      const gallery = await refreshAuthoritativeGallery(
        operation.focusMediaId,
        operation.focusFilePicker,
      );
      if (!galleryIntentIsConfirmed(operation, gallery)) {
        galleryOperationReference.current = undefined;
        setGalleryOperation({
          canRetry: false,
          message:
            "A solicitação antiga foi reconhecida, mas uma versão mais recente já substituiu seu resultado. Faça uma nova ação sobre a galeria atual.",
          status: "error",
        });
        return;
      }
      galleryOperationReference.current = undefined;
      setGalleryOperation(undefined);
      setDeleteConfirmationId(undefined);
      announce(
        operation.kind === "ordem"
          ? `Foto movida para a posição ${
              gallery.items.findIndex((item) => item.id === operation.focusMediaId) + 1
            } de ${gallery.items.length}.`
          : `${operation.kind[0]?.toUpperCase()}${operation.kind.slice(1)} atualizada com sucesso.`,
      );
    } catch (error) {
      if (boundaryChanged(error)) return;
      const local = galleryReference.current;
      if (isConflictError(error) && local !== undefined) {
        galleryOperationReference.current = undefined;
        setGalleryOperation(undefined);
        await recoverConflict(operation.kind, local);
        return;
      }
      if (isAmbiguousStudioError(error)) {
        setGalleryOperation({
          canRetry: false,
          message: "O resultado não foi confirmado. Verifique o estado atual antes de repetir.",
          status: "ambiguous",
        });
        return;
      }
      galleryOperationReference.current = undefined;
      setGalleryOperation({ canRetry: false, message: errorMessage(error), status: "error" });
    }
  }

  async function verifyGalleryOperation() {
    const operation = galleryOperationReference.current;
    if (operation === undefined) return;
    setGalleryOperation({
      canRetry: false,
      message: "Verificando a galeria salva.",
      status: "pending",
    });
    const refreshed = await mediaQuery.refetch();
    if (!refreshed.isSuccess) {
      if (!boundaryChanged(refreshed.error)) {
        setGalleryOperation({
          canRetry: false,
          message: "Não foi possível confirmar o estado. Nenhuma repetição foi iniciada.",
          status: "ambiguous",
        });
      }
      return;
    }
    const gallery = assertStudioMediaBoundary(refreshed.data, userId, studioId);
    if (galleryIntentIsConfirmed(operation, gallery)) {
      galleryOperationReference.current = undefined;
      setGalleryOperation(undefined);
      setDeleteConfirmationId(undefined);
      announce("A ação já estava confirmada na galeria canônica.");
      return;
    }
    setGalleryOperation({
      canRetry: true,
      message:
        "A ação não aparece na versão salva. Você pode repetir exatamente a mesma solicitação.",
      status: "error",
    });
  }

  function galleryCommandBoundary(gallery: StudioMediaGallery) {
    return {
      expectedRevisionId: gallery.revisionId,
      expectedRevisionVersion: gallery.revisionVersion,
      studioId,
    };
  }

  function markPreviewExpired(mediaId: string) {
    if (expiredPreviewIdsReference.current.has(mediaId)) return;
    expiredPreviewIdsReference.current.add(mediaId);
    setExpiredPreviewIds(new Set(expiredPreviewIdsReference.current));
    announce("Uma prévia privada expirou. Renove as URLs temporárias para continuar.");
  }

  async function renewPreviews() {
    try {
      await refreshAuthoritativeGallery();
      announce("Prévias privadas renovadas.");
    } catch (error) {
      if (!boundaryChanged(error)) {
        announce("Não foi possível renovar as prévias agora. Tente novamente.");
      }
    }
  }

  function moveMedia(item: MediaItem, offset: -1 | 1) {
    const gallery = galleryReference.current;
    if (gallery === undefined) return;
    const from = gallery.items.findIndex((candidate) => candidate.id === item.id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= gallery.items.length) return;
    const orderedMediaIds = gallery.items.map((candidate) => candidate.id);
    [orderedMediaIds[from], orderedMediaIds[to]] = [orderedMediaIds[to]!, orderedMediaIds[from]!];
    void executeGalleryOperation({
      command: {
        action: "studio.media.reorder",
        expectedScope: userId,
        idempotencyKey: crypto.randomUUID(),
        payload: { ...galleryCommandBoundary(gallery), orderedMediaIds },
      },
      focusMediaId: item.id,
      kind: "ordem",
    });
  }

  function setCover(item: MediaItem) {
    const gallery = galleryReference.current;
    if (gallery === undefined) return;
    void executeGalleryOperation({
      command: {
        action: "studio.media.cover.set",
        expectedScope: userId,
        idempotencyKey: crypto.randomUUID(),
        payload: { ...galleryCommandBoundary(gallery), mediaId: item.id },
      },
      focusMediaId: item.id,
      kind: "capa",
    });
  }

  function confirmDelete(item: MediaItem) {
    const gallery = galleryReference.current;
    if (gallery === undefined) return;
    const index = gallery.items.findIndex((candidate) => candidate.id === item.id);
    const focusTarget = gallery.items[index + 1] ?? gallery.items[index - 1];
    void executeGalleryOperation({
      command: {
        action: "studio.media.delete",
        expectedScope: userId,
        idempotencyKey: crypto.randomUUID(),
        payload: { ...galleryCommandBoundary(gallery), mediaId: item.id },
      },
      focusFilePicker: focusTarget === undefined,
      ...(focusTarget === undefined ? {} : { focusMediaId: focusTarget.id }),
      kind: "exclusão",
    });
  }

  function cancelDelete(mediaId: string) {
    setDeleteConfirmationId(undefined);
    requestAnimationFrame(() => deleteButtonReferences.current.get(mediaId)?.focus());
  }

  const closeLightbox = useCallback(() => setLightboxId(undefined), []);
  const gallery = mediaQuery.data;
  const galleryVerified =
    gallery !== undefined && mediaQuery.fetchStatus === "idle" && !mediaQuery.isError;

  if (!galleryVerified) {
    const verifying = mediaQuery.fetchStatus === "fetching";
    return (
      <Alert
        title={verifying ? "Verificando a galeria segura" : "Não foi possível verificar as fotos"}
        variant={verifying ? "status" : "error"}
      >
        <Stack space={3}>
          <span>
            {verifying
              ? "Fotos, arquivos e controles permanecem ocultos até a confirmação autoritativa da sessão."
              : "Nenhuma mídia privada foi exibida. Verifique novamente antes de continuar."}
          </span>
          {verifying ? null : (
            <Button onClick={() => void mediaQuery.refetch()} variant="secondary">
              Verificar novamente
            </Button>
          )}
        </Stack>
      </Alert>
    );
  }

  const scopedGallery = assertStudioMediaBoundary(gallery, userId, studioId);
  const ambiguousUpload = attempts.some((attempt) => attempt.phase === "ambiguous");
  const commandLocked =
    queueRunning ||
    prepareMutation.isPending ||
    finalizeMutation.isPending ||
    galleryMutation.isPending ||
    ambiguousUpload ||
    conflict !== undefined ||
    galleryOperation !== undefined ||
    mediaQuery.fetchStatus !== "idle";
  const mutationLocked = !scopedGallery.canEdit || commandLocked;
  const revisionPending = scopedGallery.revisionStatus === "pending";
  const selectedLightboxItem = scopedGallery.items.find((item) => item.id === lightboxId);
  const conflictChanged =
    conflict?.remote !== undefined &&
    (conflict.local.revisionId !== conflict.remote.revisionId ||
      conflict.local.revisionNumber !== conflict.remote.revisionNumber ||
      conflict.local.revisionVersion !== conflict.remote.revisionVersion ||
      conflict.local.items.map((item) => `${item.id}:${item.isCover}`).join("|") !==
        conflict.remote.items.map((item) => `${item.id}:${item.isCover}`).join("|"));

  return (
    <div className={styles.root}>
      <StudioEditorNavigation current="midia" studioId={studioId} />

      <div className={styles.summary}>
        <div>
          <p className={styles.eyebrow}>
            {revisionPending
              ? "Revisão em análise"
              : scopedGallery.revisionStatus === "approved"
                ? "Publicação atual"
                : "Rascunho privado"}
          </p>
          <h2 className={styles.sectionTitle}>Galeria do estúdio</h2>
        </div>
        <p className={styles.counter}>
          <strong>{scopedGallery.items.length}</strong> de {studioMediaMaximumFiles} fotos
        </p>
      </div>

      {revisionPending ? (
        <Alert title="Revisão pendente e imutável">
          As fotos enviadas continuam disponíveis para conferência, mas só poderão ser alteradas
          depois de uma decisão editorial.
        </Alert>
      ) : null}

      {announcement === undefined ? null : (
        <p
          aria-live="polite"
          className={styles.announcement}
          key={announcement.sequence}
          role="status"
        >
          {announcement.text}
        </p>
      )}

      {expiredPreviewIds.size === 0 ? null : (
        <Alert title="Uma prévia privada expirou" variant="error">
          <Stack space={3}>
            <span>
              {expiredPreviewIds.size === 1
                ? "Uma foto precisa de uma nova URL temporária."
                : `${expiredPreviewIds.size} fotos precisam de novas URLs temporárias.`}
            </span>
            <Button onClick={() => void renewPreviews()} variant="secondary">
              Renovar prévias
            </Button>
          </Stack>
        </Alert>
      )}

      {conflict === undefined ? null : (
        <Alert title="A galeria mudou em outra sessão" variant="error">
          <Stack space={3}>
            <span>
              {conflict.status === "loading"
                ? "Lendo a versão salva antes de liberar qualquer novo comando."
                : conflict.status === "error"
                  ? "A releitura falhou. A galeria continua bloqueada e nenhuma ação foi repetida."
                  : conflictChanged
                    ? `A ordem ou a capa mudou durante a ação de ${conflict.kind}. Revise a versão salva.`
                    : `A versão avançou durante a ação de ${conflict.kind}. Revise os fatos salvos.`}
            </span>
            {conflict.status === "error" ? (
              <Button
                onClick={() => void recoverConflict(conflict.kind, conflict.local)}
                variant="secondary"
              >
                Verificar novamente
              </Button>
            ) : conflict.status === "ready" && conflict.remote !== undefined ? (
              <Button
                onClick={() => {
                  const remote = conflict.remote;
                  if (remote === undefined) return;
                  galleryReference.current = publishStudioMediaGallery(
                    queryClient,
                    remote,
                    userId,
                    studioId,
                  );
                  setConflict(undefined);
                  announce("Versão salva aceita. Faça uma nova ação se ainda for necessária.");
                }}
                variant="secondary"
              >
                Usar versão salva
              </Button>
            ) : null}
          </Stack>
        </Alert>
      )}

      {galleryOperation === undefined ? null : (
        <Alert
          title={
            galleryOperation.status === "pending"
              ? "Atualizando a galeria"
              : "A ação precisa de confirmação"
          }
          variant={galleryOperation.status === "pending" ? "status" : "error"}
        >
          <Stack space={3}>
            <span>{galleryOperation.message}</span>
            {galleryOperation.status === "ambiguous" ? (
              <Button onClick={() => void verifyGalleryOperation()} variant="secondary">
                Verificar estado atual
              </Button>
            ) : galleryOperation.canRetry ? (
              <Button
                onClick={() => {
                  const operation = galleryOperationReference.current;
                  if (operation !== undefined) void executeGalleryOperation(operation);
                }}
                variant="secondary"
              >
                Repetir a mesma solicitação
              </Button>
            ) : galleryOperation.status === "error" ? (
              <Button onClick={() => setGalleryOperation(undefined)} variant="secondary">
                Fechar aviso
              </Button>
            ) : null}
          </Stack>
        </Alert>
      )}

      <div className={styles.workspace}>
        {scopedGallery.canEdit ? (
          <section aria-labelledby="studio-media-upload-title" className={styles.uploadSection}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.subsectionTitle} id="studio-media-upload-title">
                Adicionar fotos
              </h3>
              <p>
                JPEG, PNG, WebP ou AVIF, até 15 MB por arquivo. Os envios são processados um por
                vez.
              </p>
            </div>
            <label className={styles.filePicker}>
              <span>Selecionar fotos</span>
              <input
                accept="image/avif,image/jpeg,image/png,image/webp"
                aria-describedby="studio-media-upload-help"
                disabled={mutationLocked || scopedGallery.items.length >= studioMediaMaximumFiles}
                multiple
                onChange={selectFiles}
                ref={filePickerReference}
                type="file"
              />
            </label>
            <p className={styles.help} id="studio-media-upload-help">
              Cada arquivo passa por preparo, envio direto e verificação autoritativa antes de
              aparecer na galeria.
            </p>
            {scopedGallery.items.length >= studioMediaMaximumFiles ? (
              <Alert title="Limite de fotos atingido">
                Exclua uma foto do rascunho antes de adicionar outra.
              </Alert>
            ) : null}

            {attempts.length === 0 ? null : (
              <ul aria-label="Fila de uploads" className={styles.uploadQueue}>
                {attempts.map((attempt) => (
                  <li className={styles.uploadAttempt} key={attempt.id}>
                    <div className={styles.uploadAttemptHeader}>
                      <strong>{attempt.fileName}</strong>
                      <span>{attempt.phase === "complete" ? "Concluído" : "Upload privado"}</span>
                    </div>
                    {["preparing", "uploading", "finalizing"].includes(attempt.phase) ? (
                      <progress aria-label={`Progresso de ${attempt.fileName}`} />
                    ) : null}
                    <p>{attempt.message}</p>
                    {attempt.retry === undefined ? null : (
                      <Button
                        disabled={mutationLocked && attempt.phase !== "ambiguous"}
                        onClick={() =>
                          attempt.retry === "verify"
                            ? void verifyUpload(attempt.id)
                            : retryUpload(attempt.id, attempt.retry === "renew")
                        }
                        variant="secondary"
                      >
                        {attempt.retry === "verify"
                          ? "Verificar estado atual"
                          : attempt.retry === "renew"
                            ? "Renovar envio"
                            : "Repetir a mesma solicitação"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <section aria-labelledby="studio-media-gallery-title" className={styles.gallerySection}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.subsectionTitle} id="studio-media-gallery-title">
              {revisionPending ? "Fotos enviadas para análise" : "Ordem do rascunho"}
            </h3>
            <p>
              {revisionPending
                ? "A capa e a ordem refletem exatamente a candidata enviada."
                : "A capa e a ordem só mudam depois de uma confirmação canônica."}
            </p>
          </div>

          {scopedGallery.items.length === 0 ? (
            <div className={styles.emptyState}>
              <strong>Nenhuma foto adicionada</strong>
              <span>Selecione o primeiro arquivo para iniciar a galeria privada.</span>
            </div>
          ) : (
            <ol className={styles.gallery}>
              {scopedGallery.items.map((item, index) => {
                const deletingCoverWithAlternatives =
                  item.isCover && scopedGallery.items.length > 1;
                const confirmingDelete = deleteConfirmationId === item.id;
                return (
                  <li className={styles.mediaCard} key={item.id}>
                    <button
                      aria-label={`Visualizar foto ${item.position}${
                        item.isCover
                          ? revisionPending
                            ? ", capa enviada para análise"
                            : ", capa do rascunho"
                          : ""
                      }`}
                      className={styles.thumbnailButton}
                      disabled={commandLocked}
                      onClick={(event) => {
                        lightboxOpenerReference.current = event.currentTarget;
                        setLightboxId(item.id);
                      }}
                      ref={(element) => {
                        if (element === null) thumbnailReferences.current.delete(item.id);
                        else thumbnailReferences.current.set(item.id, element);
                      }}
                      type="button"
                    >
                      <span className={styles.imageFrame}>
                        <Image
                          alt=""
                          className={styles.thumbnail}
                          height={item.height}
                          onError={() => markPreviewExpired(item.id)}
                          src={item.previewUrl}
                          unoptimized
                          width={item.width}
                        />
                      </span>
                    </button>
                    <div className={styles.mediaMeta}>
                      <strong>Foto {item.position}</strong>
                      <span>
                        {item.isCover
                          ? revisionPending
                            ? "Capa enviada para análise"
                            : "Capa do rascunho"
                          : revisionPending
                            ? "Foto enviada para análise"
                            : "Foto privada"}
                      </span>
                    </div>
                    {scopedGallery.canEdit ? (
                      <div className={styles.cardActions}>
                        <Button
                          aria-label={`Mover foto ${item.position} para cima`}
                          disabled={mutationLocked || index === 0}
                          onClick={() => moveMedia(item, -1)}
                          variant="secondary"
                        >
                          Mover para cima
                        </Button>
                        <Button
                          aria-label={`Mover foto ${item.position} para baixo`}
                          disabled={mutationLocked || index === scopedGallery.items.length - 1}
                          onClick={() => moveMedia(item, 1)}
                          variant="secondary"
                        >
                          Mover para baixo
                        </Button>
                        {item.isCover ? null : (
                          <Button
                            aria-label={`Definir foto ${item.position} como capa`}
                            disabled={mutationLocked}
                            onClick={() => setCover(item)}
                            variant="secondary"
                          >
                            Definir como capa
                          </Button>
                        )}
                        <Button
                          aria-label={`Excluir foto ${item.position}`}
                          disabled={mutationLocked}
                          onClick={() => setDeleteConfirmationId(item.id)}
                          ref={(element) => {
                            if (element === null) deleteButtonReferences.current.delete(item.id);
                            else deleteButtonReferences.current.set(item.id, element);
                          }}
                          variant="ghost"
                        >
                          Excluir foto
                        </Button>
                      </div>
                    ) : null}
                    {scopedGallery.canEdit && confirmingDelete ? (
                      <div
                        aria-label={`Confirmar exclusão da foto ${item.position}`}
                        className={styles.deleteConfirmation}
                        role="group"
                      >
                        <p>
                          {deletingCoverWithAlternatives
                            ? "Defina outra foto como capa antes de excluir a capa atual."
                            : "A foto será removida somente deste rascunho. Deseja continuar?"}
                        </p>
                        <div className={styles.confirmationActions}>
                          {deletingCoverWithAlternatives ? null : (
                            <Button
                              disabled={mutationLocked}
                              onClick={() => confirmDelete(item)}
                              variant="secondary"
                            >
                              Confirmar exclusão
                            </Button>
                          )}
                          <Button
                            disabled={mutationLocked}
                            onClick={() => cancelDelete(item.id)}
                            variant="ghost"
                          >
                            Manter foto
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      {selectedLightboxItem === undefined ? null : (
        <MediaLightbox
          item={selectedLightboxItem}
          items={scopedGallery.items}
          onNavigate={setLightboxId}
          onPreviewExpired={markPreviewExpired}
          onRefresh={() => void renewPreviews()}
          onRequestClose={closeLightbox}
          openerReference={lightboxOpenerReference}
          previewExpired={expiredPreviewIds.has(selectedLightboxItem.id)}
          readOnly={!scopedGallery.canEdit}
        />
      )}
    </div>
  );
}

export function StudioMediaPanel({
  studioId,
  userId,
}: Readonly<{ studioId: string; userId: string }>) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <>
        <Alert title="Preparando a galeria segura" variant="status">
          Aguarde enquanto conectamos os controles privados desta página.
        </Alert>
        <noscript>
          Ative o JavaScript e recarregue a página para gerenciar as fotos privadas do estúdio.
        </noscript>
      </>
    );
  }
  return <HydratedStudioMediaPanel studioId={studioId} userId={userId} />;
}
