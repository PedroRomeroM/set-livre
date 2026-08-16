"use client";

import type { OwnerStudioEditorResult, StudioCoreInput } from "@set-livre/contracts";
import { Alert, Button, Stack } from "@set-livre/ui";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

import { clearIdentityAndAccountQueryCache } from "@/domains/identity/components/account-query-keys";

import { readStudioEditor, StudioApiError } from "./studio-api";
import {
  StudioCoreForm,
  type StudioCoreFormRawBridge,
  type StudioCoreFormRawValues,
  type StudioRecoveryAttempt,
  type StudioSaveRecoveryAttempt,
} from "./studio-core-form";
import {
  beginStudioScopeTransitionOnce,
  isStudioNotFoundError,
  isStudioSessionChangedError,
  studioMutationResultCanPublish,
  studioReadRequiresScopeTransition,
  type StudioScopeTransitionGuard,
} from "./studio-mutation";
import {
  ownerStudioQueryKeys,
  publishNewestStudioEditorMutationResult,
  readNewestStudioEditorResult,
  seedAuthoritativeStudioEditor,
  StudioEditorScopeChangedError,
  studioEditorCanRender,
  studioEditorForBoundary,
  studioEditorMatchesBoundary,
} from "./studio-query-keys";
import styles from "./studio.module.css";

type StudioEditorEditResult = Extract<OwnerStudioEditorResult, { mode: "edit" }>;
type StudioRevisionSnapshot = NonNullable<StudioEditorEditResult["studio"]["draft"]>;

type VerificationState = Readonly<{
  attempt: StudioRecoveryAttempt;
  error: StudioApiError;
  verified: boolean;
}>;

type StudioEditorPanelProps = Readonly<{
  initialResult: OwnerStudioEditorResult;
  studioId?: string | undefined;
  userId: string;
}>;

function displayAddress(core: StudioRevisionSnapshot["core"] | StudioCoreInput) {
  const complement = core.address.complement === null ? "" : ` · ${core.address.complement}`;
  return `${core.address.street}, ${core.address.streetNumber}${complement} · ${core.address.neighborhood} · Curitiba · PR · CEP ${core.address.postalCode}`;
}

function studioTypeName(result: OwnerStudioEditorResult, core: StudioCoreInput) {
  return (
    result.studioTypes.find((candidate) => candidate.id === core.studioTypeId)?.name ??
    "Tipo indisponível"
  );
}

function CoreSummary({
  core,
  heading,
  headingRef,
  typeName,
}: Readonly<{
  core: StudioCoreInput;
  heading: string;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  typeName: string;
}>) {
  return (
    <article className={styles.previewCard}>
      <h3
        className={styles.previewTitle}
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
      >
        {heading}
      </h3>
      <dl className={styles.previewDetails}>
        <div>
          <dt>Nome</dt>
          <dd>{core.name}</dd>
        </div>
        <div>
          <dt>Tipo e capacidade</dt>
          <dd>
            {typeName} · {core.capacity} {core.capacity === 1 ? "pessoa" : "pessoas"}
          </dd>
        </div>
        <div>
          <dt>Descrição</dt>
          <dd className={styles.preformatted}>{core.description}</dd>
        </div>
        <div>
          <dt>Endereço</dt>
          <dd>{displayAddress(core)}</dd>
        </div>
      </dl>
    </article>
  );
}

function SavedRevisionSummary({
  heading,
  revision,
}: Readonly<{ heading: string; revision: StudioRevisionSnapshot }>) {
  return (
    <CoreSummary
      core={revision.core}
      heading={`${heading} · revisão ${revision.revisionNumber}`}
      typeName={revision.core.studioTypeName}
    />
  );
}

function StudioPreview({ result }: Readonly<{ result: StudioEditorEditResult }>) {
  return (
    <section aria-labelledby="studio-preview-title" className={styles.previewSection}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="studio-preview-title">
          Pré-visualização
        </h2>
        <p className={styles.sectionDescription}>Esta pré-visualização ainda não está publicada.</p>
      </div>
      {result.studio.draft === null ? (
        <Alert title="Nenhum rascunho ativo">
          Não há rascunho ativo. Ao salvar, uma nova revisão será criada sem alterar a versão
          aprovada.
        </Alert>
      ) : null}
      <div className={styles.previewGrid}>
        {result.studio.draft === null ? null : (
          <SavedRevisionSummary heading="Rascunho" revision={result.studio.draft} />
        )}
        {result.studio.published === null ? null : (
          <SavedRevisionSummary heading="Versão aprovada" revision={result.studio.published} />
        )}
      </div>
    </section>
  );
}

function clearPrivateStudioCache(queryClient: QueryClient) {
  clearIdentityAndAccountQueryCache(queryClient);
}

function publishStudioResult(
  queryClient: QueryClient,
  expectedUserId: string,
  expectedStudioId: string,
  result: StudioEditorEditResult,
  scopeTransitionGuard: StudioScopeTransitionGuard,
  onScopeTransition: () => void,
) {
  if (!studioMutationResultCanPublish(scopeTransitionGuard)) return false;
  try {
    publishNewestStudioEditorMutationResult(queryClient, expectedUserId, expectedStudioId, result);
    return true;
  } catch {
    onScopeTransition();
    return false;
  }
}

function VerificationPanel({
  current,
  focusRef,
  isFetching,
  onReapply,
  onUseCurrent,
  onVerify,
  promptRef,
  result,
  state,
}: Readonly<{
  current: OwnerStudioEditorResult;
  focusRef: RefObject<HTMLHeadingElement | null>;
  isFetching: boolean;
  onReapply: (attempt: StudioSaveRecoveryAttempt) => void;
  onUseCurrent: () => void;
  onVerify: () => void;
  promptRef: RefObject<HTMLDivElement | null>;
  result: OwnerStudioEditorResult;
  state: VerificationState;
}>) {
  if (!state.verified) {
    const conflict = state.error.code === "CONFLICT";
    return (
      <div className={styles.feedbackFocus} ref={promptRef} tabIndex={-1}>
        <Stack space={3}>
          <Alert
            title={
              conflict
                ? "O rascunho mudou em outro lugar"
                : "Confirme o estado atual antes de tentar novamente"
            }
            variant="error"
          >
            {state.error.message}
          </Alert>
          <div className={styles.actions}>
            <Button
              loading={isFetching}
              loadingLabel="Verificando estado atual"
              onClick={onVerify}
              variant="secondary"
            >
              Verificar e comparar
            </Button>
          </div>
        </Stack>
      </div>
    );
  }

  const attempt = state.attempt;
  if (attempt.kind === "discard") {
    return (
      <section aria-labelledby="studio-discard-verification-title" className={styles.comparison}>
        <h2
          className={styles.sectionTitle}
          id="studio-discard-verification-title"
          ref={focusRef}
          tabIndex={-1}
        >
          Estado atual verificado
        </h2>
        <Alert>O editor foi recarregado. Revise o rascunho antes de decidir novamente.</Alert>
        <div className={styles.actions}>
          <Button onClick={onUseCurrent} variant="secondary">
            Continuar com o estado atual
          </Button>
        </div>
      </section>
    );
  }

  const attemptedCore = attempt.core;
  const currentRevision =
    current.mode === "edit" ? (current.studio.draft ?? current.studio.published) : null;
  return (
    <section aria-labelledby="studio-comparison-title" className={styles.comparison}>
      <div className={styles.sectionHeader}>
        <h2
          className={styles.sectionTitle}
          id="studio-comparison-title"
          ref={focusRef}
          tabIndex={-1}
        >
          Compare antes de continuar
        </h2>
        <p className={styles.sectionDescription}>
          Nenhuma alteração será enviada até você escolher uma base e salvar explicitamente.
        </p>
      </div>
      <div className={styles.previewGrid}>
        {currentRevision === null ? (
          <Alert title="Criação não encontrada">
            O estado atual não contém o estúdio desta tentativa. Você pode retomar os campos sem
            enviar automaticamente.
          </Alert>
        ) : (
          <CoreSummary
            core={currentRevision.core}
            heading="Versão atual"
            typeName={currentRevision.core.studioTypeName}
          />
        )}
        <CoreSummary
          core={attemptedCore}
          heading="Sua tentativa"
          typeName={studioTypeName(result, attemptedCore)}
        />
      </div>
      <div className={styles.actions}>
        <Button onClick={onUseCurrent} variant="secondary">
          Editar a partir da versão atual
        </Button>
        <Button onClick={() => onReapply(attempt)}>Reaplicar meus campos ao formulário</Button>
      </div>
    </section>
  );
}

function PreparedStudioEditorPanel({ initialResult, studioId, userId }: StudioEditorPanelProps) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ownerStudioQueryKeys.editor(userId, studioId), [studioId, userId]);
  const [createRecoveryStudioId, setCreateRecoveryStudioId] = useState<string>();
  const [recoveredCreateEditor, setRecoveredCreateEditor] = useState<StudioEditorEditResult>();
  const [formOverride, setFormOverride] = useState<StudioCoreInput>();
  const [formRevision, setFormRevision] = useState(0);
  const [dirtyScopeProbeReading, setDirtyScopeProbeReading] = useState(false);
  const [scopeTransitionStarted, setScopeTransitionStarted] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>();
  const [verification, setVerification] = useState<VerificationState>();
  const [verificationReadError, setVerificationReadError] = useState<string>();
  const [verificationReading, setVerificationReading] = useState(false);
  const readErrorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const comparisonFocusRef = useRef<HTMLHeadingElement>(null);
  const verificationPromptRef = useRef<HTMLDivElement>(null);
  const verificationReadErrorRef = useRef<HTMLDivElement>(null);
  const dirtyScopeProbeInFlightRef = useRef(false);
  const formDirtyRef = useRef(false);
  const formMutationPendingRef = useRef(false);
  const rawFormBridgeRef = useRef<StudioCoreFormRawBridge | undefined>(undefined);
  const rawFormValuesRef = useRef<StudioCoreFormRawValues | undefined>(undefined);
  const rawRestorePendingRef = useRef(false);
  const scopeTransitionGuard = useRef(false);
  const recoveredStudioId = recoveredCreateEditor?.studio.id;
  const clearEphemeralFormRefs = useCallback(() => {
    formMutationPendingRef.current = false;
    rawFormBridgeRef.current = undefined;
    rawFormValuesRef.current = undefined;
    rawRestorePendingRef.current = false;
  }, []);
  const registerRawFormBridge = useCallback(
    (bridge: StudioCoreFormRawBridge | undefined) => {
      rawFormBridgeRef.current = bridge;
      if (bridge === undefined || !rawRestorePendingRef.current) return;
      const rawValues = rawFormValuesRef.current;
      if (rawValues === undefined || !bridge.restore(rawValues)) {
        scopeTransitionGuard.current = true;
        clearEphemeralFormRefs();
        setCreateRecoveryStudioId(undefined);
        setRecoveredCreateEditor(undefined);
        clearPrivateStudioCache(queryClient);
        window.location.reload();
        return;
      }
      rawRestorePendingRef.current = false;
      rawFormValuesRef.current = undefined;
    },
    [clearEphemeralFormRefs, queryClient],
  );
  const resultQuery = useQuery({
    initialData: initialResult,
    queryFn: () => {
      setSuccessMessage(undefined);
      return readNewestStudioEditorResult(queryClient, userId, studioId, () =>
        readStudioEditor(userId, studioId),
      );
    },
    queryKey,
    refetchOnMount: "always",
    refetchOnReconnect: () => !formDirtyRef.current && !formMutationPendingRef.current,
    refetchOnWindowFocus: () => !formDirtyRef.current && !formMutationPendingRef.current,
    retry: false,
    staleTime: 0,
  });
  const observedResult = resultQuery.data;
  const resultCanRender =
    observedResult !== undefined &&
    studioEditorCanRender(observedResult, userId, studioId, resultQuery.fetchStatus);
  const observedScopeChanged =
    observedResult !== undefined && !studioEditorMatchesBoundary(observedResult, userId, studioId);
  const authoritativeScopeChanged =
    resultQuery.error instanceof StudioEditorScopeChangedError ||
    (studioId !== undefined && isStudioNotFoundError(resultQuery.error));
  const scopeTransitionRequired = studioReadRequiresScopeTransition({
    authoritativeScopeChanged,
    error: resultQuery.error,
    observedScopeChanged,
  });

  const executeScopeTransition = useCallback(
    (commitBoundary: () => void) => {
      beginStudioScopeTransitionOnce(
        scopeTransitionGuard,
        commitBoundary,
        () => clearPrivateStudioCache(queryClient),
        () => window.location.reload(),
      );
    },
    [queryClient],
  );

  const beginMutationScopeTransition = useCallback(() => {
    formDirtyRef.current = false;
    clearEphemeralFormRefs();
    executeScopeTransition(() => {
      flushSync(() => {
        setCreateRecoveryStudioId(undefined);
        setRecoveredCreateEditor(undefined);
        setScopeTransitionStarted(true);
      });
    });
  }, [clearEphemeralFormRefs, executeScopeTransition]);

  const beginObservedScopeTransition = useCallback(() => {
    formDirtyRef.current = false;
    clearEphemeralFormRefs();
    executeScopeTransition(() => {
      setCreateRecoveryStudioId(undefined);
      setRecoveredCreateEditor(undefined);
      setScopeTransitionStarted(true);
    });
  }, [clearEphemeralFormRefs, executeScopeTransition]);

  const probeDirtyStudioScope = useCallback(async () => {
    if (
      (!formDirtyRef.current && !formMutationPendingRef.current) ||
      scopeTransitionGuard.current ||
      dirtyScopeProbeInFlightRef.current
    ) {
      return;
    }

    dirtyScopeProbeInFlightRef.current = true;
    const rawValues = rawFormBridgeRef.current?.capture();
    if (rawValues === undefined) {
      beginMutationScopeTransition();
      return;
    }
    rawFormValuesRef.current = rawValues;
    flushSync(() => {
      setSuccessMessage(undefined);
      setDirtyScopeProbeReading(true);
    });

    try {
      studioEditorForBoundary(
        await readStudioEditor(userId, recoveredStudioId ?? studioId),
        userId,
        recoveredStudioId ?? studioId,
      );
      if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
      if (!formDirtyRef.current && !formMutationPendingRef.current) {
        rawFormValuesRef.current = undefined;
        rawRestorePendingRef.current = false;
        flushSync(() => setDirtyScopeProbeReading(false));
        return;
      }
      if (rawFormValuesRef.current !== rawValues) {
        beginMutationScopeTransition();
        return;
      }
      rawRestorePendingRef.current = true;
      flushSync(() => setDirtyScopeProbeReading(false));
    } catch {
      beginMutationScopeTransition();
    } finally {
      dirtyScopeProbeInFlightRef.current = false;
    }
  }, [beginMutationScopeTransition, recoveredStudioId, studioId, userId]);

  useLayoutEffect(() => {
    scopeTransitionGuard.current = false;
    return () => {
      scopeTransitionGuard.current = true;
      formDirtyRef.current = false;
      clearEphemeralFormRefs();
    };
  }, [clearEphemeralFormRefs]);

  useLayoutEffect(() => {
    if (scopeTransitionRequired) beginObservedScopeTransition();
  }, [beginObservedScopeTransition, scopeTransitionRequired]);

  useEffect(() => {
    const probe = () => void probeDirtyStudioScope();
    const probeWhenVisible = () => {
      if (document.visibilityState === "visible") probe();
    };
    window.addEventListener("focus", probe);
    window.addEventListener("online", probe);
    document.addEventListener("visibilitychange", probeWhenVisible);
    return () => {
      window.removeEventListener("focus", probe);
      window.removeEventListener("online", probe);
      document.removeEventListener("visibilitychange", probeWhenVisible);
    };
  }, [probeDirtyStudioScope]);

  useEffect(() => {
    if (successMessage !== undefined) successRef.current?.focus();
  }, [successMessage]);

  useEffect(() => {
    if (verification?.verified === true) {
      comparisonFocusRef.current?.focus();
    } else if (verification !== undefined) {
      verificationPromptRef.current?.focus();
    }
  }, [verification]);

  useEffect(() => {
    if (verificationReadError !== undefined) verificationReadErrorRef.current?.focus();
  }, [verificationReadError]);

  useEffect(() => {
    if (resultQuery.isError) readErrorRef.current?.focus();
  }, [resultQuery.isError]);

  if (
    scopeTransitionStarted ||
    scopeTransitionRequired ||
    verificationReading ||
    (observedResult !== undefined && !resultCanRender)
  ) {
    return <Alert>Validando o editor privado do estúdio…</Alert>;
  }

  if (resultQuery.isError || observedResult === undefined) {
    if (isStudioSessionChangedError(resultQuery.error)) {
      return <Alert>Validando o editor privado do estúdio…</Alert>;
    }
    const message =
      resultQuery.error instanceof StudioApiError
        ? resultQuery.error.message
        : "Não foi possível validar o editor do estúdio.";
    return (
      <div className={styles.feedbackFocus} ref={readErrorRef} tabIndex={-1}>
        <Stack space={4}>
          <Alert title="Editor do estúdio indisponível" variant="error">
            {message}
          </Alert>
          <div className={styles.actions}>
            <Button
              loading={resultQuery.isFetching}
              loadingLabel="Validando editor"
              onClick={() => void resultQuery.refetch()}
              variant="secondary"
            >
              Tentar novamente
            </Button>
          </div>
        </Stack>
      </div>
    );
  }

  const navigateToStudioEditor = (targetStudioId: string) => {
    if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
    scopeTransitionGuard.current = true;
    formDirtyRef.current = false;
    clearEphemeralFormRefs();
    flushSync(() => {
      setCreateRecoveryStudioId(undefined);
      setRecoveredCreateEditor(undefined);
      setFormOverride(undefined);
      setVerification(undefined);
      setVerificationReadError(undefined);
      setScopeTransitionStarted(true);
    });
    clearPrivateStudioCache(queryClient);
    window.location.replace(`/dono/estudios/${targetStudioId}/dados`);
  };

  const publishSavedResult = (updated: StudioEditorEditResult, message: string) => {
    if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
    if (recoveredCreateEditor !== undefined) {
      if (updated.studio.id !== recoveredCreateEditor.studio.id) {
        beginMutationScopeTransition();
        return;
      }
      navigateToStudioEditor(updated.studio.id);
      return;
    }
    if (studioId === undefined) return;
    formDirtyRef.current = false;
    clearEphemeralFormRefs();
    setCreateRecoveryStudioId(undefined);
    setRecoveredCreateEditor(undefined);
    setSuccessMessage(message);
    setFormOverride(undefined);
    if (
      !publishStudioResult(
        queryClient,
        userId,
        studioId,
        updated,
        scopeTransitionGuard,
        beginMutationScopeTransition,
      )
    ) {
      return;
    }
    setFormRevision((current) => current + 1);
  };

  const verifyCurrentState = async () => {
    if (verification === undefined || !studioMutationResultCanPublish(scopeTransitionGuard)) return;
    setVerificationReadError(undefined);
    setVerificationReading(true);
    try {
      if (verification.attempt.kind === "create") {
        try {
          const created = studioEditorForBoundary(
            await readStudioEditor(userId, verification.attempt.studioId),
            userId,
            verification.attempt.studioId,
          );
          if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
          if (created.mode !== "edit") throw new StudioEditorScopeChangedError();
          formDirtyRef.current = false;
          clearEphemeralFormRefs();
          setCreateRecoveryStudioId(undefined);
          setRecoveredCreateEditor(created);
        } catch (error) {
          if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
          if (
            isStudioSessionChangedError(error) ||
            error instanceof StudioEditorScopeChangedError
          ) {
            beginMutationScopeTransition();
            return;
          }
          if (!(error instanceof StudioApiError) || error.code !== "NOT_FOUND") throw error;
          setRecoveredCreateEditor(undefined);
        }
      } else if (recoveredCreateEditor !== undefined) {
        if (verification.attempt.studioId !== recoveredCreateEditor.studio.id) {
          beginMutationScopeTransition();
          return;
        }
        const refreshed = studioEditorForBoundary(
          await readStudioEditor(userId, verification.attempt.studioId),
          userId,
          verification.attempt.studioId,
        );
        if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
        if (refreshed.mode !== "edit") throw new StudioEditorScopeChangedError();
        setRecoveredCreateEditor(refreshed);
      } else {
        const refreshed = await readNewestStudioEditorResult(queryClient, userId, studioId, () =>
          readStudioEditor(userId, studioId),
        );
        if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
        queryClient.setQueryData(queryKey, refreshed);
      }
      if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
      setVerification((current) =>
        current === undefined ? undefined : { ...current, verified: true },
      );
    } catch (error) {
      if (!studioMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isStudioNotFoundError(error)) {
        if (verification.attempt.kind === "discard") {
          scopeTransitionGuard.current = true;
          formDirtyRef.current = false;
          clearEphemeralFormRefs();
          setCreateRecoveryStudioId(undefined);
          flushSync(() => {
            setRecoveredCreateEditor(undefined);
            setScopeTransitionStarted(true);
          });
          clearPrivateStudioCache(queryClient);
          window.location.replace("/dono/estudios/novo");
        } else {
          beginMutationScopeTransition();
        }
        return;
      }
      if (isStudioSessionChangedError(error) || error instanceof StudioEditorScopeChangedError) {
        beginMutationScopeTransition();
        return;
      }
      setVerificationReadError(
        error instanceof StudioApiError
          ? error.message
          : "Não foi possível verificar o editor agora. Tente novamente.",
      );
    } finally {
      if (studioMutationResultCanPublish(scopeTransitionGuard)) {
        setVerificationReading(false);
      }
    }
  };

  const resetToCurrent = () => {
    if (recoveredCreateEditor !== undefined) {
      navigateToStudioEditor(recoveredCreateEditor.studio.id);
      return;
    }
    const preservedCreateStudioId =
      verification?.attempt.kind === "create" ? verification.attempt.studioId : undefined;
    formDirtyRef.current = false;
    clearEphemeralFormRefs();
    setCreateRecoveryStudioId(preservedCreateStudioId);
    setVerification(undefined);
    setVerificationReadError(undefined);
    setFormOverride(undefined);
    setFormRevision((current) => current + 1);
  };

  const reapplyAttempt = (attempt: StudioSaveRecoveryAttempt) => {
    if (
      recoveredCreateEditor !== undefined &&
      attempt.studioId !== recoveredCreateEditor.studio.id
    ) {
      beginMutationScopeTransition();
      return;
    }
    formDirtyRef.current = true;
    clearEphemeralFormRefs();
    setCreateRecoveryStudioId(
      recoveredCreateEditor === undefined && attempt.kind === "create"
        ? attempt.studioId
        : undefined,
    );
    setVerification(undefined);
    setVerificationReadError(undefined);
    setFormOverride(attempt.core);
    setFormRevision((current) => current + 1);
  };

  const effectiveResult = recoveredCreateEditor ?? observedResult;
  const effectiveStudioId =
    effectiveResult.mode === "edit" ? effectiveResult.studio.id : (studioId ?? "new");
  const editVersion = effectiveResult.mode === "edit" ? effectiveResult.studio.editVersion : 0;
  const formKey = `${effectiveResult.mode}:${effectiveStudioId}:${editVersion}:${formRevision}`;

  return (
    <Stack space={6}>
      {dirtyScopeProbeReading ? (
        <Alert>Validando o editor privado do estúdio…</Alert>
      ) : (
        <>
          {successMessage === undefined ? null : (
            <div className={styles.feedbackFocus} ref={successRef} tabIndex={-1}>
              <Alert title="Alteração confirmada">{successMessage}</Alert>
            </div>
          )}

          {verificationReadError === undefined ? null : (
            <div className={styles.feedbackFocus} ref={verificationReadErrorRef} tabIndex={-1}>
              <Alert title="Não foi possível verificar o estado atual" variant="error">
                {verificationReadError}
              </Alert>
            </div>
          )}

          {verification === undefined ? null : (
            <VerificationPanel
              current={effectiveResult}
              focusRef={comparisonFocusRef}
              isFetching={verificationReading || resultQuery.isFetching}
              onReapply={reapplyAttempt}
              onUseCurrent={resetToCurrent}
              onVerify={() => void verifyCurrentState()}
              promptRef={verificationPromptRef}
              result={effectiveResult}
              state={verification}
            />
          )}
        </>
      )}

      {effectiveResult.studioTypes.length === 0 ? (
        dirtyScopeProbeReading ? null : (
          <Alert title="Tipos de estúdio indisponíveis">
            Nenhum tipo ativo está disponível neste ambiente. O cadastro permanece indisponível até
            a taxonomia ser configurada.
          </Alert>
        )
      ) : (
        <StudioCoreForm
          createStudioId={createRecoveryStudioId}
          expectedScope={userId}
          initialCore={formOverride}
          key={formKey}
          locked={verification !== undefined}
          onCreated={(created) => {
            navigateToStudioEditor(created.studio.id);
          }}
          onDiscarded={(discarded) => {
            formDirtyRef.current = false;
            clearEphemeralFormRefs();
            setCreateRecoveryStudioId(undefined);
            if (discarded.outcome === "studio_removed") {
              scopeTransitionGuard.current = true;
              flushSync(() => {
                setRecoveredCreateEditor(undefined);
                setScopeTransitionStarted(true);
              });
              clearPrivateStudioCache(queryClient);
              window.location.replace("/dono/estudios/novo");
              return;
            }
            publishSavedResult(discarded.editor, "Rascunho descartado com segurança.");
          }}
          onNeedsVerification={(attempt, error) => {
            if (attempt.kind === "create") setRecoveredCreateEditor(undefined);
            setCreateRecoveryStudioId(attempt.kind === "create" ? attempt.studioId : undefined);
            setSuccessMessage(undefined);
            setVerification({ attempt, error, verified: false });
          }}
          onPendingChange={(pending) => {
            formMutationPendingRef.current = pending;
          }}
          onDirty={() => {
            formDirtyRef.current = true;
            rawFormValuesRef.current = undefined;
            setSuccessMessage(undefined);
          }}
          onSaved={publishSavedResult}
          onSessionChanged={beginMutationScopeTransition}
          registerRawFormBridge={registerRawFormBridge}
          result={effectiveResult}
          scopeProbeHidden={dirtyScopeProbeReading}
          scopeTransitionGuard={scopeTransitionGuard}
        />
      )}

      {!dirtyScopeProbeReading && effectiveResult.mode === "edit" ? (
        <StudioPreview result={effectiveResult} />
      ) : null}
    </Stack>
  );
}

export function StudioEditorPanel({ initialResult, studioId, userId }: StudioEditorPanelProps) {
  const queryClient = useQueryClient();
  const [preparedInitialResult, setPreparedInitialResult] = useState<OwnerStudioEditorResult>();
  const seedIsCurrent = preparedInitialResult === initialResult;

  useEffect(() => {
    let active = true;
    if (!studioEditorMatchesBoundary(initialResult, userId, studioId)) {
      clearPrivateStudioCache(queryClient);
      window.location.reload();
      return () => {
        active = false;
      };
    }
    clearPrivateStudioCache(queryClient);
    seedAuthoritativeStudioEditor(queryClient, userId, studioId, initialResult);
    queueMicrotask(() => {
      if (active) setPreparedInitialResult(initialResult);
    });
    return () => {
      active = false;
    };
  }, [initialResult, queryClient, studioId, userId]);

  if (!seedIsCurrent) return <Alert>Validando o editor privado do estúdio…</Alert>;

  return (
    <PreparedStudioEditorPanel
      initialResult={preparedInitialResult}
      studioId={studioId}
      userId={userId}
    />
  );
}
