"use client";

import {
  ownerActivatePayloadSchema,
  type OwnerActivationResult,
  type OwnerContract,
  type OwnerNextAction,
  type OwnerRecipientResult,
  type OwnerRecipientStatus,
  type RecipientRequirement,
  type RecipientStatus,
} from "@set-livre/contracts";
import { Alert, Button, Checkbox, Stack } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

import { clearIdentityAndAccountQueryCache } from "@/domains/identity/components/account-query-keys";
import { LegalMarkdown } from "@/domains/legal/components/legal-markdown";

import {
  activateOwner,
  OwnerApiError,
  readOwnerActivation,
  readOwnerRecipient,
  refreshRecipientOnboarding,
  startRecipientOnboarding,
} from "./owner-api";
import {
  beginOwnerScopeTransitionOnce,
  cleanupOwnerMutationAttemptOnce,
  isOwnerAmbiguousCommandError,
  isOwnerSessionChangedError,
  isOwnerUnscopedValidationError,
  ownerMutationNetworkMode,
  ownerMutationRequiresVerification,
  ownerMutationResultCanPublish,
  ownerReadRequiresScopeTransition,
  requireOwnerMutationAttempt,
  type OwnerMutationAttempt,
  type OwnerScopeTransitionGuard,
} from "./owner-mutation";
import {
  OwnerPrivateScopeChangedError,
  ownerPrivateCanRender,
  ownerPrivateMatchesBoundary,
  ownerQueryKey,
  publishNewestOwnerPrivateMutationResult,
  readNewestOwnerPrivateResult,
  seedAuthoritativeOwnerPrivate,
} from "./owner-query-keys";
import {
  ownerHasCurrentContract,
  ownerNeedsCurrentContractAcceptance,
  ownerRecipientActionsAvailable,
  ownerRecipientOnboardingAvailable,
  ownerRecipientProfileNeedsSync,
} from "./owner-view-state";
import styles from "./owner.module.css";

type OwnerRecipientPanelProps = Readonly<
  | {
      initialResult: OwnerActivationResult;
      userId: string;
      view: "overview";
    }
  | {
      initialResult: OwnerRecipientStatus;
      userId: string;
      view: "recipient";
    }
>;

type PublishOwnerResult = (result: OwnerRecipientResult, message: string) => void;
type RefreshOwnerResult = Readonly<{ isSuccess: boolean }>;
type RefreshOwner = () => Promise<RefreshOwnerResult>;

const recipientRequirementLabels: Record<RecipientRequirement, string> = {
  additional_information: "Informações adicionais",
  identity_review: "Análise de identidade",
  provider_contact: "Contato com o provedor após a liberação da integração externa",
};

const recipientStatusLabels: Record<RecipientStatus, string> = {
  active: "Ativo",
  blocked: "Bloqueado",
  not_started: "Não iniciado",
  pending: "Em análise local",
  refused: "Não aprovado",
  suspended: "Suspenso",
};

const recipientStatusDescriptions: Record<RecipientStatus, string> = {
  active: "A validação local retornou estado ativo.",
  blocked: "Este cadastro está bloqueado e não possui uma ação disponível nesta etapa.",
  not_started: "A validação local de recebimentos ainda não foi iniciada.",
  pending: "A validação local está pendente. Atualize o status para consultar o próximo estado.",
  refused: "A validação não foi aprovada. Somente uma ação indicada pelo estado atual é exibida.",
  suspended:
    "A validação está suspensa. Atualize o status somente quando a ação estiver disponível.",
};

function displayDate(isoDate: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "long",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(isoDate));
}

function createIdempotencyKey() {
  return crypto.randomUUID();
}

function clearOwnerPrivateCache(queryClient: QueryClient) {
  clearIdentityAndAccountQueryCache(queryClient);
}

function OwnerLocalAdapterNotice() {
  return (
    <Alert title="Validação exclusiva do ambiente local" variant="error">
      Este fluxo usa um adapter determinístico para desenvolvimento e testes. Ele não representa
      cadastro, análise ou aprovação de um gateway em produção.
    </Alert>
  );
}

function OwnerChecklist({
  focusRef,
  result,
}: Readonly<{
  focusRef: RefObject<HTMLHeadingElement | null>;
  result: OwnerRecipientResult;
}>) {
  const currentContractAccepted = ownerHasCurrentContract(result);
  const ownerLabel = currentContractAccepted
    ? "Concluída"
    : result.ownerStatus === "blocked"
      ? "Bloqueada"
      : "Pendente";
  const recipientLabel =
    result.recipientStatus === "blocked"
      ? "Bloqueada"
      : result.reservationsEligible
        ? "Concluída"
        : "Pendente";

  return (
    <section aria-labelledby="owner-checklist-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="owner-checklist-title" ref={focusRef} tabIndex={-1}>
          Etapas para receber reservas
        </h2>
        <p className={styles.sectionDescription}>
          Cada etapa mostra o estado canônico atual. Disponibilidade para reservas depende de todas
          elas.
        </p>
      </div>
      <ol className={styles.checklist}>
        <li className={styles.checklistItem}>
          <span className={styles.checklistStatus}>Concluída</span>
          <span className={styles.checklistCopy}>
            <span className={styles.checklistTitle}>Perfil da conta</span>
            <span className={styles.checklistDescription}>
              Os dados obrigatórios do titular estão completos.
            </span>
          </span>
        </li>
        <li className={styles.checklistItem}>
          <span className={styles.checklistStatus}>{ownerLabel}</span>
          <span className={styles.checklistCopy}>
            <span className={styles.checklistTitle}>Ativação como dono</span>
            <span className={styles.checklistDescription}>
              {currentContractAccepted
                ? "O contrato do dono foi aceito e a autoridade está ativa."
                : result.ownerStatus === "blocked"
                  ? "A autoridade de dono está bloqueada e não pode avançar."
                  : result.ownerStatus === "active"
                    ? "Uma nova versão do contrato precisa ser lida e aceita."
                    : "É necessário ler e aceitar o contrato do dono."}
            </span>
          </span>
        </li>
        <li className={styles.checklistItem}>
          <span className={styles.checklistStatus}>{recipientLabel}</span>
          <span className={styles.checklistCopy}>
            <span className={styles.checklistTitle}>Cadastro de recebimentos</span>
            <span className={styles.checklistDescription}>
              {result.reservationsEligible
                ? "O recebedor está ativo e sincronizado com a versão atual do perfil."
                : ownerNeedsCurrentContractAcceptance(result)
                  ? "Uma nova versão do contrato precisa ser aceita antes de liberar reservas."
                  : ownerRecipientProfileNeedsSync(result)
                    ? "O recebedor está ativo, mas o perfil precisa ser sincronizado novamente."
                    : result.recipientStatus === "active"
                      ? "O recebedor está ativo, mas a elegibilidade ainda não foi confirmada."
                      : result.recipientStatus === "blocked"
                        ? "O cadastro de recebimentos está bloqueado."
                        : "O recebedor ainda não está apto para liberar reservas."}
            </span>
          </span>
        </li>
      </ol>
    </section>
  );
}

function OwnerContractDocument({ contract }: Readonly<{ contract: OwnerContract }>) {
  return (
    <div className={styles.contractDocument}>
      <p className={styles.contractMeta}>
        Versão {contract.version} · vigente desde {displayDate(contract.effectiveAt)}
      </p>
      {contract.source === "local_fixture" ? (
        <Alert title="Contrato não aprovado para produção" variant="error">
          Este texto é uma fixture local para desenvolvimento e testes. Não constitui contrato
          jurídico aprovado.
        </Alert>
      ) : null}
      <LegalMarkdown
        bodyMarkdown={contract.bodyMarkdown}
        className={styles.contractBody}
        documentTitle={contract.title}
      />
    </div>
  );
}

function MutationError({
  error,
  needsVerification,
  onVerify,
}: Readonly<{
  error: OwnerApiError | undefined;
  needsVerification: boolean;
  onVerify: () => void;
}>) {
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error !== undefined) feedbackRef.current?.focus();
  }, [error]);

  if (error === undefined) return null;
  const conflict = error.code === "CONFLICT";
  return (
    <div className={styles.feedbackFocus} ref={feedbackRef} tabIndex={-1}>
      <Stack space={3}>
        <Alert
          title={
            needsVerification
              ? "Confirme o estado atual antes de tentar novamente"
              : conflict
                ? "O cadastro mudou em outro lugar"
                : "Não foi possível concluir"
          }
          variant="error"
        >
          {error.message}
        </Alert>
        {needsVerification || conflict ? (
          <div className={styles.actions}>
            <Button onClick={onVerify} variant="secondary">
              Verificar estado atual
            </Button>
          </div>
        ) : null}
      </Stack>
    </div>
  );
}

function OwnerActivationForm({
  expectedScope,
  onRefresh,
  onSave,
  onSessionChanged,
  result,
  scopeTransitionGuard,
}: Readonly<{
  expectedScope: string;
  onRefresh: RefreshOwner;
  onSave: PublishOwnerResult;
  onSessionChanged: () => void;
  result: OwnerActivationResult;
  scopeTransitionGuard: OwnerScopeTransitionGuard;
}>) {
  const pendingActivation = useRef<
    OwnerMutationAttempt<{ ownerContractVersionId: string }> | undefined
  >(undefined);
  const [fieldError, setFieldError] = useState<string>();
  const [needsVerification, setNeedsVerification] = useState(false);
  const fieldErrorRef = useRef<HTMLDivElement>(null);

  function cleanupAttemptOnce() {
    cleanupOwnerMutationAttemptOnce(pendingActivation.current, () => {
      pendingActivation.current = undefined;
    });
  }

  const mutation = useMutation({
    mutationFn: () => {
      const attempt = requireOwnerMutationAttempt(
        pendingActivation.current,
        "A ativação do dono não possui uma tentativa efêmera.",
      );
      return activateOwner(
        attempt.expectedScope,
        attempt.idempotencyKey,
        attempt.payload.ownerContractVersionId,
      );
    },
    networkMode: ownerMutationNetworkMode,
    onError: (error) => {
      cleanupAttemptOnce();
      if (!ownerMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isOwnerSessionChangedError(error)) {
        onSessionChanged();
        return;
      }
      setNeedsVerification(
        isOwnerAmbiguousCommandError(error) || isOwnerUnscopedValidationError(error),
      );
    },
    onSuccess: (updated) => {
      cleanupAttemptOnce();
      if (!ownerMutationResultCanPublish(scopeTransitionGuard)) return;
      setNeedsVerification(false);
      onSave(updated, "Perfil de dono ativado com segurança.");
    },
  });

  function submitActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsVerification || ownerMutationRequiresVerification(mutation.error)) {
      return;
    }
    mutation.reset();
    setFieldError(undefined);
    setNeedsVerification(false);
    const form = new FormData(event.currentTarget);
    const parsed = ownerActivatePayloadSchema.safeParse({
      acceptOwnerContract: form.get("acceptOwnerContract") === "on",
      ownerContractVersionId: result.ownerContract.id,
    });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Aceite o contrato do dono para continuar.");
      return;
    }
    pendingActivation.current = {
      expectedScope,
      idempotencyKey: createIdempotencyKey(),
      payload: { ownerContractVersionId: parsed.data.ownerContractVersionId },
    };
    mutation.mutate();
  }

  const apiError = mutation.error instanceof OwnerApiError ? mutation.error : undefined;
  const visibleFieldError = apiError?.fieldErrors.acceptOwnerContract ?? fieldError;
  const verificationRequired = needsVerification || ownerMutationRequiresVerification(apiError);

  useEffect(() => {
    if (visibleFieldError !== undefined) fieldErrorRef.current?.focus();
  }, [visibleFieldError]);

  return (
    <form className={styles.form} noValidate onSubmit={submitActivation}>
      <MutationError
        error={apiError}
        needsVerification={needsVerification}
        onVerify={() => {
          void onRefresh().then((verification) => {
            if (!verification.isSuccess) return;
            mutation.reset();
            setNeedsVerification(false);
          });
        }}
      />
      <div className={styles.legalChoice}>
        <Checkbox
          {...(visibleFieldError === undefined
            ? {}
            : {
                "aria-describedby": "acceptOwnerContract-error",
                "aria-invalid": true,
              })}
          disabled={mutation.isPending || verificationRequired}
          id="acceptOwnerContract"
          label={`Li e aceito o Contrato do Dono, versão ${result.ownerContract.version}.`}
          name="acceptOwnerContract"
          required
        />
        {visibleFieldError === undefined ? null : (
          <div className={styles.feedbackFocus} ref={fieldErrorRef} tabIndex={-1}>
            <Alert id="acceptOwnerContract-error" variant="error">
              {visibleFieldError}
            </Alert>
          </div>
        )}
      </div>
      <div className={styles.actions}>
        <Button
          disabled={verificationRequired}
          loading={mutation.isPending}
          loadingLabel={
            result.ownerStatus === "active"
              ? "Aceitando contrato vigente"
              : "Ativando perfil de dono"
          }
          type="submit"
        >
          {result.ownerStatus === "active" ? "Aceitar contrato vigente" : "Ativar perfil de dono"}
        </Button>
      </div>
    </form>
  );
}

function OwnerActivationSection({
  expectedScope,
  onRefresh,
  onSave,
  onSessionChanged,
  result,
  scopeTransitionGuard,
}: Readonly<{
  expectedScope: string;
  onRefresh: RefreshOwner;
  onSave: PublishOwnerResult;
  onSessionChanged: () => void;
  result: OwnerActivationResult;
  scopeTransitionGuard: OwnerScopeTransitionGuard;
}>) {
  if (result.ownerStatus === "blocked") {
    return (
      <section aria-labelledby="owner-activation-title" className={styles.section}>
        <h2 className={styles.sectionTitle} id="owner-activation-title">
          Ativação como dono
        </h2>
        <Alert title="Perfil de dono bloqueado" variant="error">
          Esta autoridade está bloqueada. Nenhuma ação de ativação ou recebimentos está disponível.
        </Alert>
      </section>
    );
  }

  if (ownerHasCurrentContract(result)) {
    return (
      <section aria-labelledby="owner-activation-title" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle} id="owner-activation-title">
            Perfil de dono ativo
          </h2>
          <p className={styles.sectionDescription}>
            O aceite do contrato foi registrado. O cadastro de recebimentos continua sendo uma etapa
            separada.
          </p>
        </div>
        <div className={styles.actions}>
          <Link className={styles.textLink} href="/dono/recebimentos">
            Ver cadastro de recebimentos
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="owner-contract-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="owner-contract-title">
          {result.ownerContract.title}
        </h2>
        <p className={styles.sectionDescription}>
          Leia o conteúdo integral antes de registrar o aceite. O aceite ativa apenas a autoridade
          de dono e não concede papel administrativo.
        </p>
      </div>
      <OwnerContractDocument contract={result.ownerContract} />
      <OwnerActivationForm
        key={result.ownerContract.id}
        expectedScope={expectedScope}
        onRefresh={onRefresh}
        onSave={onSave}
        onSessionChanged={onSessionChanged}
        result={result}
        scopeTransitionGuard={scopeTransitionGuard}
      />
    </section>
  );
}

function recipientStatusDescription(result: OwnerRecipientResult) {
  if (ownerNeedsCurrentContractAcceptance(result)) {
    return "O recebedor permanece registrado, mas uma nova versão do contrato do dono precisa ser aceita. As reservas continuam bloqueadas.";
  }
  if (ownerRecipientProfileNeedsSync(result)) {
    return "O recebedor está ativo, mas o perfil mudou desde a última sincronização. As reservas continuam bloqueadas até uma nova atualização.";
  }
  if (result.reservationsEligible) {
    return "O recebedor está ativo e sincronizado com a versão atual do perfil. A elegibilidade local está liberada.";
  }
  if (result.recipientStatus === "active") {
    return "O recebedor está ativo, mas a elegibilidade para reservas ainda não foi confirmada.";
  }
  return recipientStatusDescriptions[result.recipientStatus];
}

function RecipientAction({
  action,
  expectedScope,
  onRefresh,
  onSave,
  onSessionChanged,
  scopeTransitionGuard,
}: Readonly<{
  action: Extract<OwnerNextAction, "refresh_status" | "start_onboarding">;
  expectedScope: string;
  onRefresh: RefreshOwner;
  onSave: PublishOwnerResult;
  onSessionChanged: () => void;
  scopeTransitionGuard: OwnerScopeTransitionGuard;
}>) {
  const pendingAction = useRef<OwnerMutationAttempt<{ action: "refresh" | "start" }> | undefined>(
    undefined,
  );
  const [needsVerification, setNeedsVerification] = useState(false);

  function cleanupAttemptOnce() {
    cleanupOwnerMutationAttemptOnce(pendingAction.current, () => {
      pendingAction.current = undefined;
    });
  }

  const mutation = useMutation({
    mutationFn: () => {
      const attempt = requireOwnerMutationAttempt(
        pendingAction.current,
        "A ação do recebedor não possui uma tentativa efêmera.",
      );
      return attempt.payload.action === "start"
        ? startRecipientOnboarding(attempt.expectedScope, attempt.idempotencyKey)
        : refreshRecipientOnboarding(attempt.expectedScope, attempt.idempotencyKey);
    },
    networkMode: ownerMutationNetworkMode,
    onError: (error) => {
      cleanupAttemptOnce();
      if (!ownerMutationResultCanPublish(scopeTransitionGuard)) return;
      if (isOwnerSessionChangedError(error)) {
        onSessionChanged();
        return;
      }
      setNeedsVerification(
        isOwnerAmbiguousCommandError(error) || isOwnerUnscopedValidationError(error),
      );
    },
    onSuccess: (updated) => {
      cleanupAttemptOnce();
      if (!ownerMutationResultCanPublish(scopeTransitionGuard)) return;
      setNeedsVerification(false);
      onSave(
        updated,
        action === "start_onboarding"
          ? "Validação local iniciada."
          : "Status de recebimentos atualizado.",
      );
    },
  });

  const apiError = mutation.error instanceof OwnerApiError ? mutation.error : undefined;
  const verificationRequired = needsVerification || ownerMutationRequiresVerification(apiError);
  const label = action === "start_onboarding" ? "Iniciar validação local" : "Atualizar status";
  const loadingLabel =
    action === "start_onboarding" ? "Iniciando validação local" : "Atualizando status";

  return (
    <Stack space={4}>
      <MutationError
        error={apiError}
        needsVerification={needsVerification}
        onVerify={() => {
          void onRefresh().then((verification) => {
            if (!verification.isSuccess) return;
            mutation.reset();
            setNeedsVerification(false);
          });
        }}
      />
      <div className={styles.actions}>
        <Button
          disabled={verificationRequired}
          loading={mutation.isPending}
          loadingLabel={loadingLabel}
          onClick={() => {
            mutation.reset();
            setNeedsVerification(false);
            pendingAction.current = {
              expectedScope,
              idempotencyKey: createIdempotencyKey(),
              payload: {
                action: action === "start_onboarding" ? "start" : "refresh",
              },
            };
            mutation.mutate();
          }}
        >
          {label}
        </Button>
      </div>
    </Stack>
  );
}

function OwnerRecipientSection({
  expectedScope,
  onRefresh,
  onSave,
  onSessionChanged,
  result,
  scopeTransitionGuard,
}: Readonly<{
  expectedScope: string;
  onRefresh: RefreshOwner;
  onSave: PublishOwnerResult;
  onSessionChanged: () => void;
  result: OwnerRecipientStatus;
  scopeTransitionGuard: OwnerScopeTransitionGuard;
}>) {
  if (!ownerRecipientActionsAvailable(result)) {
    return (
      <section aria-labelledby="recipient-status-title" className={styles.section}>
        <h2 className={styles.sectionTitle} id="recipient-status-title">
          Cadastro de recebimentos
        </h2>
        <Stack space={4}>
          <Alert
            title={
              result.ownerStatus === "blocked"
                ? "Perfil de dono bloqueado"
                : result.ownerStatus === "active"
                  ? "Aceite o contrato vigente primeiro"
                  : "Ative seu perfil de dono primeiro"
            }
            variant={result.ownerStatus === "blocked" ? "error" : "status"}
          >
            {result.ownerStatus === "blocked"
              ? "O cadastro de recebimentos não pode avançar enquanto a autoridade de dono estiver bloqueada."
              : result.ownerStatus === "active"
                ? "Uma nova versão do contrato do dono precisa ser aceita antes de consultar ou alterar o cadastro de recebimentos."
                : "O aceite do contrato do dono é obrigatório antes de iniciar a validação local de recebimentos."}
          </Alert>
          {result.ownerStatus !== "blocked" ? (
            <div className={styles.actions}>
              <Link className={styles.textLink} href="/dono">
                Ir para ativação
              </Link>
            </div>
          ) : null}
        </Stack>
      </section>
    );
  }

  const action =
    result.nextAction === "start_onboarding" || result.nextAction === "refresh_status"
      ? result.nextAction
      : undefined;
  const onboardingAvailable = ownerRecipientOnboardingAvailable(result);

  return (
    <section aria-labelledby="recipient-status-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="recipient-status-title">
          Cadastro de recebimentos
        </h2>
        <p className={styles.sectionDescription}>
          A página mostra somente estados e próximos passos internos. Identificadores e payloads do
          provider permanecem privados.
        </p>
      </div>
      {onboardingAvailable ? (
        <OwnerLocalAdapterNotice />
      ) : (
        <Alert title="Cadastro de recebimentos indisponível" variant="status">
          A integração de recebimentos ainda não está disponível neste ambiente. O estado atual
          permanece somente para consulta.
        </Alert>
      )}
      <div className={styles.statusDetails}>
        <h3 className={styles.statusTitle}>
          {result.recipientStatus === "active" && !result.reservationsEligible
            ? "Atualização necessária"
            : recipientStatusLabels[result.recipientStatus]}
        </h3>
        <p className={styles.statusDescription}>{recipientStatusDescription(result)}</p>
        {result.requirements.length === 0 ? null : (
          <div>
            <p className={styles.statusTitle}>Pendências informadas</p>
            <ul className={styles.requirements}>
              {result.requirements.map((requirement) => (
                <li key={requirement}>{recipientRequirementLabels[requirement]}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {action === undefined || !onboardingAvailable ? null : (
        <RecipientAction
          action={action}
          expectedScope={expectedScope}
          onRefresh={onRefresh}
          onSave={onSave}
          onSessionChanged={onSessionChanged}
          scopeTransitionGuard={scopeTransitionGuard}
        />
      )}
    </section>
  );
}

function OwnerContent(
  props: Readonly<{
    expectedScope: string;
    onSave: PublishOwnerResult;
    onSessionChanged: () => void;
    refreshResult: RefreshOwner;
    result: OwnerRecipientResult;
    scopeTransitionGuard: OwnerScopeTransitionGuard;
    verificationFocusRef: RefObject<HTMLHeadingElement | null>;
  }>,
) {
  const {
    expectedScope,
    onSave,
    onSessionChanged,
    refreshResult,
    result,
    scopeTransitionGuard,
    verificationFocusRef,
  } = props;
  return (
    <Stack space={6}>
      <OwnerChecklist focusRef={verificationFocusRef} result={result} />
      {result.projection === "activation" ? (
        <OwnerActivationSection
          expectedScope={expectedScope}
          onRefresh={refreshResult}
          onSave={onSave}
          onSessionChanged={onSessionChanged}
          result={result}
          scopeTransitionGuard={scopeTransitionGuard}
        />
      ) : (
        <OwnerRecipientSection
          expectedScope={expectedScope}
          onRefresh={refreshResult}
          onSave={onSave}
          onSessionChanged={onSessionChanged}
          result={result}
          scopeTransitionGuard={scopeTransitionGuard}
        />
      )}
    </Stack>
  );
}

function publishOwnerResult(
  queryClient: QueryClient,
  expectedUserId: string,
  result: OwnerRecipientResult,
  scopeTransitionGuard: OwnerScopeTransitionGuard,
  onScopeTransition: () => void,
) {
  if (!ownerMutationResultCanPublish(scopeTransitionGuard)) return;
  try {
    if (result.projection === "activation") {
      publishNewestOwnerPrivateMutationResult(queryClient, expectedUserId, "activation", result);
    } else {
      publishNewestOwnerPrivateMutationResult(queryClient, expectedUserId, "recipient", result);
    }
  } catch {
    onScopeTransition();
  }
}

function PreparedOwnerRecipientPanel({ initialResult, userId, view }: OwnerRecipientPanelProps) {
  const queryClient = useQueryClient();
  const expectedProjection = view === "overview" ? "activation" : "recipient";
  const queryKey = useMemo(
    () => ownerQueryKey(expectedProjection, userId),
    [expectedProjection, userId],
  );
  const [scopeTransitionStarted, setScopeTransitionStarted] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>();
  const readErrorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const verificationFocusRef = useRef<HTMLHeadingElement>(null);
  const verificationFocusRequested = useRef(false);
  const scopeTransitionGuard = useRef(false);
  const resultQuery = useQuery<OwnerRecipientResult>({
    initialData: initialResult,
    queryFn: async () =>
      view === "overview"
        ? readNewestOwnerPrivateResult(queryClient, userId, "activation", readOwnerActivation)
        : readNewestOwnerPrivateResult(queryClient, userId, "recipient", readOwnerRecipient),
    queryKey,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 0,
  });
  const observedResult = resultQuery.data;
  const resultCanRender =
    observedResult !== undefined &&
    ownerPrivateCanRender(observedResult, userId, expectedProjection, resultQuery.fetchStatus);
  const observedScopeChanged =
    observedResult !== undefined &&
    !ownerPrivateMatchesBoundary(observedResult, userId, expectedProjection);
  const authoritativeScopeChanged = resultQuery.error instanceof OwnerPrivateScopeChangedError;
  const scopeTransitionRequired = ownerReadRequiresScopeTransition({
    authoritativeScopeChanged,
    error: resultQuery.error,
    observedScopeChanged,
  });

  const executeScopeTransition = useCallback(
    (commitBoundary: () => void) => {
      beginOwnerScopeTransitionOnce(
        scopeTransitionGuard,
        commitBoundary,
        () => clearOwnerPrivateCache(queryClient),
        () => window.location.reload(),
      );
    },
    [queryClient],
  );

  const beginMutationScopeTransition = useCallback(() => {
    executeScopeTransition(() => {
      flushSync(() => setScopeTransitionStarted(true));
    });
  }, [executeScopeTransition]);

  const beginObservedScopeTransition = useCallback(() => {
    executeScopeTransition(() => setScopeTransitionStarted(true));
  }, [executeScopeTransition]);

  useLayoutEffect(() => {
    if (!scopeTransitionRequired) return;
    beginObservedScopeTransition();
  }, [beginObservedScopeTransition, scopeTransitionRequired]);

  useEffect(() => {
    if (successMessage !== undefined) successRef.current?.focus();
  }, [successMessage]);

  useEffect(() => {
    if (
      !verificationFocusRequested.current ||
      resultQuery.fetchStatus !== "idle" ||
      scopeTransitionRequired
    ) {
      return;
    }
    verificationFocusRequested.current = false;
    if (resultQuery.isError) {
      readErrorRef.current?.focus();
      return;
    }
    if (resultCanRender) verificationFocusRef.current?.focus();
  }, [resultCanRender, resultQuery.fetchStatus, resultQuery.isError, scopeTransitionRequired]);

  const refreshResult: RefreshOwner = () => {
    verificationFocusRequested.current = true;
    return resultQuery.refetch();
  };

  if (
    scopeTransitionStarted ||
    scopeTransitionRequired ||
    (observedResult !== undefined && !resultCanRender)
  ) {
    return <Alert>Validando o estado privado da área do dono…</Alert>;
  }

  if (resultQuery.isError || observedResult === undefined) {
    const message =
      resultQuery.error instanceof OwnerApiError
        ? resultQuery.error.message
        : "Não foi possível validar a área do dono.";
    return (
      <div className={styles.feedbackFocus} ref={readErrorRef} tabIndex={-1}>
        <Stack space={4}>
          <Alert title="Área do dono indisponível" variant="error">
            {message}
          </Alert>
          <div className={styles.actions}>
            <Button
              loading={resultQuery.isFetching}
              loadingLabel="Validando estado"
              onClick={() => void refreshResult()}
              variant="secondary"
            >
              Tentar novamente
            </Button>
          </div>
        </Stack>
      </div>
    );
  }

  const saveResult: PublishOwnerResult = (updated, message) => {
    if (!ownerMutationResultCanPublish(scopeTransitionGuard)) return;
    setSuccessMessage(message);
    publishOwnerResult(
      queryClient,
      userId,
      updated,
      scopeTransitionGuard,
      beginMutationScopeTransition,
    );
  };

  return (
    <Stack space={5}>
      {successMessage === undefined ? null : (
        <div className={styles.feedbackFocus} ref={successRef} tabIndex={-1}>
          <Alert title="Alteração confirmada">{successMessage}</Alert>
        </div>
      )}
      <OwnerContent
        expectedScope={userId}
        onSave={saveResult}
        onSessionChanged={beginMutationScopeTransition}
        refreshResult={refreshResult}
        result={observedResult}
        scopeTransitionGuard={scopeTransitionGuard}
        verificationFocusRef={verificationFocusRef}
      />
    </Stack>
  );
}

export function OwnerRecipientPanel(props: OwnerRecipientPanelProps) {
  const { initialResult, userId, view } = props;
  const queryClient = useQueryClient();
  const [preparedInitialResult, setPreparedInitialResult] = useState<OwnerRecipientResult>();
  const seedIsCurrent = preparedInitialResult === initialResult;
  const expectedProjection = view === "overview" ? "activation" : "recipient";

  useEffect(() => {
    let active = true;
    if (!ownerPrivateMatchesBoundary(initialResult, userId, expectedProjection)) {
      clearOwnerPrivateCache(queryClient);
      window.location.reload();
      return () => {
        active = false;
      };
    }
    clearOwnerPrivateCache(queryClient);
    if (initialResult.projection === "activation") {
      seedAuthoritativeOwnerPrivate(queryClient, userId, "activation", initialResult);
    } else {
      seedAuthoritativeOwnerPrivate(queryClient, userId, "recipient", initialResult);
    }
    queueMicrotask(() => {
      if (active) setPreparedInitialResult(initialResult);
    });
    return () => {
      active = false;
    };
  }, [expectedProjection, initialResult, queryClient, userId]);

  if (!seedIsCurrent) {
    return <Alert>Validando o estado privado da área do dono…</Alert>;
  }

  if (props.view === "overview") {
    if (preparedInitialResult.projection !== "activation") {
      return <Alert>Validando o estado privado da área do dono…</Alert>;
    }
    return (
      <PreparedOwnerRecipientPanel
        initialResult={preparedInitialResult}
        userId={userId}
        view="overview"
      />
    );
  }
  if (preparedInitialResult.projection !== "recipient") {
    return <Alert>Validando o estado privado da área do dono…</Alert>;
  }
  return (
    <PreparedOwnerRecipientPanel
      initialResult={preparedInitialResult}
      userId={userId}
      view="recipient"
    />
  );
}
