"use client";

import {
  formatStudioPostalCode,
  studioCorePayloadSchema,
  type StudioEditor,
  type StudioTypeOption,
} from "@set-livre/contracts";
import { Alert, Button, ButtonLink, Field, Input, Select, Stack, Textarea } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { IdentityApiError, readIdentitySession } from "@/domains/identity/components/identity-api";
import {
  IdentitySessionScopeChangedError,
  identityQueryKeys,
  identitySessionCanRender,
  identitySessionForScope,
  identitySessionMatchesScope,
} from "@/domains/identity/components/identity-query-keys";
import { useHydrated } from "@/lib/client/use-hydrated";

import {
  createStudio,
  discardStudioDraft,
  isAmbiguousStudioError,
  isStudioBoundaryChangedError,
  readStudioEditor,
  readStudioTypes,
  StudioApiError,
  updateStudioCore,
} from "./studio-api";
import {
  assertStudioEditorBoundary,
  publishStudioEditor,
  recomposeStudioClientBoundary,
  studioEditorCanRender,
  studioRevisionToken,
  StudioScopeChangedError,
  studioQueryKeys,
  type StudioRevisionToken,
} from "./studio-query-keys";
import styles from "./studio.module.css";

type FieldErrors = Readonly<Record<string, string>>;

type StudioCoreFormState = {
  addressComplement: string;
  capacity: string;
  city: "Curitiba";
  description: string;
  name: string;
  neighborhood: string;
  postalCode: string;
  state: "PR";
  street: string;
  streetNumber: string;
  studioTypeId: string;
};

type CreateCommand = Parameters<typeof createStudio>[0];
type UpdateCommand = Parameters<typeof updateStudioCore>[0];
type DiscardCommand = Parameters<typeof discardStudioDraft>[0];

const emptyFormState: StudioCoreFormState = {
  addressComplement: "",
  capacity: "",
  city: "Curitiba",
  description: "",
  name: "",
  neighborhood: "",
  postalCode: "",
  state: "PR",
  street: "",
  streetNumber: "",
  studioTypeId: "",
};

const fieldLabels: Readonly<Record<keyof StudioCoreFormState, string>> = {
  addressComplement: "Complemento",
  capacity: "Capacidade",
  city: "Cidade",
  description: "Descrição",
  name: "Nome",
  neighborhood: "Bairro",
  postalCode: "CEP",
  state: "UF",
  street: "Rua ou avenida",
  streetNumber: "Número",
  studioTypeId: "Tipo de estúdio",
};

function editorFormState(editor: StudioEditor): StudioCoreFormState {
  return {
    addressComplement: editor.revision.addressComplement ?? "",
    capacity: String(editor.revision.capacity),
    city: "Curitiba",
    description: editor.revision.description,
    name: editor.revision.name,
    neighborhood: editor.revision.neighborhood,
    postalCode: formatStudioPostalCode(editor.revision.postalCode),
    state: "PR",
    street: editor.revision.street,
    streetNumber: editor.revision.streetNumber,
    studioTypeId: editor.revision.studioTypeId,
  };
}

function firstFieldErrors(error: { issues: readonly { message: string; path: PropertyKey[] }[] }) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (
      (typeof field === "string" || typeof field === "number") &&
      fieldErrors[field] === undefined
    ) {
      fieldErrors[String(field)] = issue.message;
    }
  }
  return fieldErrors;
}

function parseCoreForm(state: StudioCoreFormState) {
  return studioCorePayloadSchema.safeParse({
    ...state,
    capacity: Number(state.capacity),
  });
}

function fieldErrorProp(errors: FieldErrors, field: keyof StudioCoreFormState) {
  const error = errors[field];
  return error === undefined ? {} : { error };
}

function apiError(error: unknown) {
  return error instanceof StudioApiError ? error : undefined;
}

function isStudioTypeUnavailableError(error: unknown) {
  return error instanceof StudioApiError && error.code === "STUDIO_TYPE_UNAVAILABLE";
}

function includeCurrentStudioType(
  types: readonly StudioTypeOption[],
  currentType: StudioEditor["studioType"],
) {
  if (types.some((type) => type.id === currentType.id)) return [...types];
  return [{ ...currentType, sortOrder: 0 }, ...types];
}

function mergeStudioTypeDescriptors(
  types: readonly StudioTypeOption[],
  descriptors: readonly StudioEditor["studioType"][],
) {
  const known = new Map(types.map((type) => [type.id, type]));
  for (const descriptor of descriptors) {
    const current = known.get(descriptor.id);
    known.set(descriptor.id, {
      ...descriptor,
      sortOrder: current?.sortOrder ?? 0,
    });
  }
  return [...known.values()];
}

function StudioMutationFeedback({
  error,
  onRetry,
}: Readonly<{
  error: StudioApiError | undefined;
  onRetry: (() => void) | undefined;
}>) {
  if (error === undefined) return null;
  const conflict = error.code === "CONFLICT";
  return (
    <Alert
      title={conflict ? "O estúdio mudou em outro lugar" : "Não foi possível salvar"}
      variant="error"
    >
      <Stack space={3}>
        <span>{error.message}</span>
        {onRetry === undefined ? null : (
          <Button onClick={onRetry} variant="secondary">
            Repetir a mesma solicitação com segurança
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

function StudioCoreFields({
  unavailableTypeId,
  disabled,
  errors,
  onChange,
  state,
  types,
}: Readonly<{
  unavailableTypeId?: string;
  disabled: boolean;
  errors: FieldErrors;
  onChange: (field: keyof StudioCoreFormState, value: string) => void;
  state: StudioCoreFormState;
  types: readonly StudioTypeOption[];
}>) {
  return (
    <>
      <section aria-labelledby="studio-identity-title" className={styles.formSection}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle} id="studio-identity-title">
            Identidade do espaço
          </h2>
          <p className={styles.sectionDescription}>
            Estes dados formarão o conteúdo público somente depois da aprovação.
          </p>
        </div>
        <div className={styles.formGrid}>
          <Field {...fieldErrorProp(errors, "name")} label="Nome do estúdio" required>
            <Input
              autoComplete="organization"
              disabled={disabled}
              maxLength={120}
              name="name"
              onChange={(event) => onChange("name", event.currentTarget.value)}
              value={state.name}
            />
          </Field>
          <Field {...fieldErrorProp(errors, "studioTypeId")} label="Tipo de estúdio" required>
            <Select
              disabled={disabled}
              name="studioTypeId"
              onChange={(event) => onChange("studioTypeId", event.currentTarget.value)}
              value={state.studioTypeId}
            >
              <option value="">Selecione</option>
              {types.map((type) => (
                <option disabled={type.id === unavailableTypeId} key={type.id} value={type.id}>
                  {type.name}
                  {type.id === unavailableTypeId ? " (arquivado)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field {...fieldErrorProp(errors, "capacity")} label="Capacidade de pessoas" required>
            <Input
              disabled={disabled}
              inputMode="numeric"
              maxLength={9}
              max={500}
              min={1}
              name="capacity"
              onChange={(event) => onChange("capacity", event.currentTarget.value)}
              type="number"
              value={state.capacity}
            />
          </Field>
        </div>
        <Field
          {...fieldErrorProp(errors, "description")}
          description={`${state.description.length.toLocaleString("pt-BR")} de 5.000 caracteres`}
          label="Descrição"
          required
        >
          <Textarea
            disabled={disabled}
            maxLength={5000}
            name="description"
            onChange={(event) => onChange("description", event.currentTarget.value)}
            rows={8}
            value={state.description}
          />
        </Field>
      </section>

      <section aria-labelledby="studio-address-title" className={styles.formSection}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle} id="studio-address-title">
            Endereço
          </h2>
          <p className={styles.sectionDescription}>
            Nesta baseline, a operação atende exclusivamente Curitiba, Paraná.
          </p>
        </div>
        <div className={styles.formGrid}>
          <Field {...fieldErrorProp(errors, "postalCode")} label="CEP" required>
            <Input
              autoComplete="postal-code"
              disabled={disabled}
              inputMode="numeric"
              maxLength={9}
              name="postalCode"
              onChange={(event) =>
                onChange("postalCode", formatStudioPostalCode(event.currentTarget.value))
              }
              placeholder="80000-000"
              value={state.postalCode}
            />
          </Field>
          <Field {...fieldErrorProp(errors, "street")} label="Rua ou avenida" required>
            <Input
              autoComplete="address-line1"
              disabled={disabled}
              maxLength={160}
              name="street"
              onChange={(event) => onChange("street", event.currentTarget.value)}
              value={state.street}
            />
          </Field>
          <Field {...fieldErrorProp(errors, "streetNumber")} label="Número" required>
            <Input
              autoComplete="address-line2"
              disabled={disabled}
              maxLength={20}
              name="streetNumber"
              onChange={(event) => onChange("streetNumber", event.currentTarget.value)}
              value={state.streetNumber}
            />
          </Field>
          <Field {...fieldErrorProp(errors, "addressComplement")} label="Complemento">
            <Input
              autoComplete="address-line3"
              disabled={disabled}
              maxLength={120}
              name="addressComplement"
              onChange={(event) => onChange("addressComplement", event.currentTarget.value)}
              value={state.addressComplement}
            />
          </Field>
          <Field {...fieldErrorProp(errors, "neighborhood")} label="Bairro" required>
            <Input
              disabled={disabled}
              maxLength={120}
              name="neighborhood"
              onChange={(event) => onChange("neighborhood", event.currentTarget.value)}
              value={state.neighborhood}
            />
          </Field>
          <Field label="Cidade" required>
            <Input name="city" readOnly value={state.city} />
          </Field>
          <Field label="UF" required>
            <Input name="state" readOnly value={state.state} />
          </Field>
        </div>
      </section>
    </>
  );
}

function StudioLocalPreview({
  state,
  types,
}: Readonly<{ state: StudioCoreFormState; types: readonly StudioTypeOption[] }>) {
  const typeName =
    types.find((type) => type.id === state.studioTypeId)?.name ?? "Tipo não selecionado";
  return (
    <section aria-labelledby="studio-preview-title" className={styles.preview}>
      <div className={styles.previewLabel}>Prévia local — não publicada</div>
      <h2 className={styles.previewTitle} id="studio-preview-title">
        {state.name.trim() === "" ? "Seu estúdio" : state.name}
      </h2>
      <p className={styles.previewMeta}>
        {typeName} ·{" "}
        {state.capacity === "" ? "Capacidade não informada" : `${state.capacity} pessoas`}
      </p>
      <p className={styles.previewDescription}>
        {state.description.trim() === ""
          ? "A descrição aparecerá aqui enquanto você preenche o formulário."
          : state.description}
      </p>
      <address className={styles.previewAddress}>
        {state.street || "Rua"}, {state.streetNumber || "número"}
        {state.addressComplement.trim() === "" ? null : `, ${state.addressComplement}`}
        <br />
        {state.neighborhood || "Bairro"} · Curitiba/PR · {state.postalCode || "CEP"}
      </address>
    </section>
  );
}

function useStudioTypes(initialTypes: readonly StudioTypeOption[]) {
  return useQuery({
    initialData: [...initialTypes],
    queryFn: ({ signal }) => readStudioTypes(signal),
    queryKey: studioQueryKeys.types,
    retry: false,
    staleTime: 0,
  });
}

function StudioTypesFeedback({
  loading,
  onRetry,
  unavailable,
}: Readonly<{ loading: boolean; onRetry: () => void; unavailable: boolean }>) {
  if (!unavailable) return null;
  return (
    <Alert title="Não foi possível confirmar os tipos ativos" variant="error">
      <Stack space={3}>
        <span>
          As opções antigas permanecem bloqueadas até uma nova confirmação do catálogo ativo.
        </span>
        <Button loading={loading} onClick={onRetry} variant="secondary">
          Atualizar tipos de estúdio
        </Button>
      </Stack>
    </Alert>
  );
}

function CreateStudioForm({
  initialTypes,
  userId,
}: Readonly<{ initialTypes: readonly StudioTypeOption[]; userId: string }>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryFn: async () => identitySessionForScope(await readIdentitySession(), userId),
    queryKey: identityQueryKeys.session(userId),
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 30_000,
  });
  const typesQuery = useStudioTypes(initialTypes);
  const pendingCommand = useRef<CreateCommand>(undefined);
  const [createdStudioId, setCreatedStudioId] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formState, setFormState] = useState<StudioCoreFormState>(emptyFormState);
  const [successMessage, setSuccessMessage] = useState<string>();
  const mutation = useMutation({
    mutationFn: () => {
      if (pendingCommand.current === undefined) {
        throw new Error("A criação não possui solicitação idempotente preparada.");
      }
      return createStudio(pendingCommand.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isStudioBoundaryChangedError(error)) {
        recomposeStudioClientBoundary(queryClient);
        return;
      }
      if (isStudioTypeUnavailableError(error)) {
        setFormState((current) => ({ ...current, studioTypeId: "" }));
        await typesQuery.refetch();
      }
    },
    onSuccess: (editor) => {
      setCreatedStudioId(editor.studioId);
      setSuccessMessage("Rascunho criado. Abra o editor canônico para continuar.");
      pendingCommand.current = undefined;
    },
  });
  const observedSession = sessionQuery.data;
  const sessionCanRender =
    observedSession !== undefined &&
    identitySessionCanRender(observedSession, userId, sessionQuery.fetchStatus);
  const observedScopeChanged =
    observedSession !== undefined && !identitySessionMatchesScope(observedSession, userId);
  const authoritativeScopeChanged = sessionQuery.error instanceof IdentitySessionScopeChangedError;
  const scopeTransitionRequired = observedScopeChanged || authoritativeScopeChanged;

  useEffect(() => {
    if (!scopeTransitionRequired) return;
    pendingCommand.current = undefined;
    recomposeStudioClientBoundary(queryClient);
  }, [queryClient, scopeTransitionRequired]);

  function updateField(field: keyof StudioCoreFormState, value: string) {
    setFormState((current) => ({ ...current, [field]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.reset();
    setFieldErrors({});
    setSuccessMessage(undefined);
    const parsed = parseCoreForm(formState);
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }
    pendingCommand.current = {
      action: "studio.create",
      expectedScope: userId,
      idempotencyKey: crypto.randomUUID(),
      payload: parsed.data,
    };
    mutation.mutate();
  }

  const error = apiError(mutation.error);
  const visibleErrors = error?.fieldErrors ?? fieldErrors;
  const hasAmbiguousRequest = error !== undefined && isAmbiguousStudioError(error);
  const retry = hasAmbiguousRequest ? () => mutation.mutate() : undefined;
  const types = typesQuery.data;
  const formLocked =
    mutation.isPending ||
    hasAmbiguousRequest ||
    createdStudioId !== undefined ||
    typesQuery.fetchStatus === "fetching" ||
    typesQuery.isError;

  if (scopeTransitionRequired || sessionQuery.fetchStatus !== "idle") {
    return <Alert>Validando sua sessão antes de criar o estúdio…</Alert>;
  }

  if (sessionQuery.isError || !sessionCanRender) {
    const message =
      sessionQuery.error instanceof IdentityApiError
        ? sessionQuery.error.message
        : "Não foi possível confirmar a identidade desta página.";
    return (
      <Stack space={4}>
        <Alert title="Sessão indisponível" variant="error">
          {message}
        </Alert>
        <div className={styles.actions}>
          <Button
            loading={sessionQuery.isFetching}
            loadingLabel="Validando sessão"
            onClick={() => {
              void sessionQuery.refetch();
            }}
            variant="secondary"
          >
            Tentar novamente
          </Button>
        </div>
      </Stack>
    );
  }

  return (
    <div className={styles.editorLayout}>
      <form className={styles.form} noValidate onSubmit={submit}>
        <StudioTypesFeedback
          loading={typesQuery.fetchStatus === "fetching"}
          onRetry={() => void typesQuery.refetch()}
          unavailable={typesQuery.isError}
        />
        {types.length === 0 ? (
          <Alert title="Nenhum tipo de estúdio está disponível" variant="error">
            A taxonomia precisa ser reativada por um administrador antes de criar um estúdio.
          </Alert>
        ) : null}
        <StudioMutationFeedback error={error} onRetry={retry} />
        {successMessage === undefined ? null : (
          <Alert title="Estúdio salvo" variant="status">
            <Stack space={3}>
              <span>{successMessage}</span>
              {createdStudioId === undefined ? null : (
                <Button
                  onClick={() => router.push(`/dono/estudios/${createdStudioId}/dados`)}
                  variant="secondary"
                >
                  Abrir editor criado
                </Button>
              )}
            </Stack>
          </Alert>
        )}
        <StudioCoreFields
          disabled={formLocked}
          errors={visibleErrors}
          onChange={updateField}
          state={formState}
          types={types}
        />
        <div className={styles.actions}>
          <Button
            disabled={formLocked || !types.some((type) => type.id === formState.studioTypeId)}
            loading={mutation.isPending}
            loadingLabel="Criando rascunho"
            type="submit"
          >
            Criar estúdio em rascunho
          </Button>
        </div>
      </form>
      <StudioLocalPreview state={formState} types={types} />
    </div>
  );
}

function conflictValue(
  field: keyof StudioCoreFormState,
  value: string,
  studioTypes: readonly StudioTypeOption[],
) {
  if (field !== "studioTypeId") return value;
  return studioTypes.find((type) => type.id === value)?.name ?? "Tipo indisponível";
}

function conflictRows(
  local: StudioCoreFormState,
  remote: StudioCoreFormState,
  studioTypes: readonly StudioTypeOption[],
) {
  return (Object.keys(fieldLabels) as Array<keyof StudioCoreFormState>)
    .filter((field) => local[field] !== remote[field])
    .map((field) => ({
      field,
      label: fieldLabels[field],
      local: conflictValue(field, local[field], studioTypes),
      remote: conflictValue(field, remote[field], studioTypes),
    }));
}

function StudioConflictComparison({
  local,
  onKeepLocal,
  onUseRemote,
  remote,
  studioTypes,
}: Readonly<{
  local: StudioCoreFormState;
  onKeepLocal: () => void;
  onUseRemote: () => void;
  remote: StudioCoreFormState;
  studioTypes: readonly StudioTypeOption[];
}>) {
  const rows = useMemo(
    () => conflictRows(local, remote, studioTypes),
    [local, remote, studioTypes],
  );
  return (
    <section aria-labelledby="studio-conflict-title" className={styles.conflict}>
      <h2 className={styles.sectionTitle} id="studio-conflict-title">
        Compare antes de continuar
      </h2>
      <p className={styles.sectionDescription}>
        Seus valores foram preservados. Escolha a versão salva ou mantenha suas alterações sobre o
        token mais recente; nenhuma opção salva automaticamente.
      </p>
      {rows.length === 0 ? (
        <p className={styles.sectionDescription}>Somente a versão técnica da revisão mudou.</p>
      ) : (
        <div className={styles.conflictTable} role="table" aria-label="Diferenças do estúdio">
          <div className={styles.conflictHeader} role="row">
            <span role="columnheader">Campo</span>
            <span role="columnheader">Sua versão</span>
            <span role="columnheader">Versão salva</span>
          </div>
          {rows.map((row) => (
            <div className={styles.conflictRow} key={row.field} role="row">
              <strong role="cell">{row.label}</strong>
              <span role="cell">
                <span aria-hidden="true" className={styles.mobileConflictLabel}>
                  Sua versão
                </span>
                <span>{row.local || "—"}</span>
              </span>
              <span role="cell">
                <span aria-hidden="true" className={styles.mobileConflictLabel}>
                  Versão salva
                </span>
                <span>{row.remote || "—"}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        <Button onClick={onUseRemote} variant="secondary">
          Usar versão salva
        </Button>
        <Button onClick={onKeepLocal}>Continuar com minhas alterações</Button>
      </div>
    </section>
  );
}

function EditStudioForm({
  discardRevision,
  externalCommandLocked,
  formRevision,
  initialEditor,
  initialTypes,
  onAuthoritativeRevisionAdvance,
  onAuthoritativeRevisionReplacement,
  onCommandFinish,
  onCommandStart,
  onDiscardRevisionChange,
  onFormRevisionChange,
  onStudioDeleted,
  userId,
}: Readonly<{
  discardRevision: StudioRevisionToken;
  externalCommandLocked: boolean;
  formRevision: StudioRevisionToken;
  initialEditor: StudioEditor;
  initialTypes: readonly StudioTypeOption[];
  onAuthoritativeRevisionAdvance: ((editor: StudioEditor) => void) | undefined;
  onAuthoritativeRevisionReplacement: ((editor: StudioEditor) => void) | undefined;
  onCommandFinish: () => void;
  onCommandStart: () => void;
  onDiscardRevisionChange: (revision: StudioRevisionToken) => void;
  onFormRevisionChange: (revision: StudioRevisionToken) => void;
  onStudioDeleted: (() => void) | undefined;
  userId: string;
}>) {
  const queryClient = useQueryClient();
  const typesQuery = useStudioTypes(initialTypes);
  const editorQueryKey = useMemo(
    () => studioQueryKeys.editor(userId, initialEditor.studioId),
    [initialEditor.studioId, userId],
  );
  const [studioDeleted, setStudioDeleted] = useState(false);
  const [pendingConflictRecovery, setPendingConflictRecovery] = useState<"discard" | "update">();
  const editorQuery = useQuery({
    enabled: !studioDeleted,
    initialData: initialEditor,
    queryFn: async ({ signal }) =>
      assertStudioEditorBoundary(
        await readStudioEditor(initialEditor.studioId, signal),
        userId,
        initialEditor.studioId,
      ),
    queryKey: editorQueryKey,
    refetchOnMount: "always",
    refetchOnReconnect: pendingConflictRecovery === undefined,
    refetchOnWindowFocus: pendingConflictRecovery === undefined ? "always" : false,
    retry: false,
    staleTime: 0,
  });
  const pendingUpdate = useRef<UpdateCommand>(undefined);
  const pendingDiscard = useRef<DiscardCommand>(undefined);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [conflictRemote, setConflictRemote] = useState<StudioEditor>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formState, setFormState] = useState(() => editorFormState(initialEditor));
  const [successMessage, setSuccessMessage] = useState<string>();

  useEffect(() => {
    if (
      editorQuery.error instanceof StudioScopeChangedError ||
      isStudioBoundaryChangedError(editorQuery.error)
    ) {
      recomposeStudioClientBoundary(queryClient);
    }
  }, [editorQuery.error, queryClient]);

  const updateMutation = useMutation({
    mutationFn: () => {
      if (pendingUpdate.current === undefined) {
        throw new Error("A atualização não possui solicitação idempotente preparada.");
      }
      return updateStudioCore(pendingUpdate.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isAmbiguousStudioError(error)) return;
      pendingUpdate.current = undefined;
      try {
        if (isStudioBoundaryChangedError(error)) {
          recomposeStudioClientBoundary(queryClient);
          return;
        }
        if (isStudioTypeUnavailableError(error)) {
          setPendingConflictRecovery(undefined);
          setConflictRemote(undefined);
          setFormState((current) => ({ ...current, studioTypeId: "" }));
          await typesQuery.refetch();
          return;
        }
        if (error instanceof StudioApiError && error.code === "CONFLICT") {
          setPendingConflictRecovery("update");
          setConflictRemote(undefined);
          const refreshed = await editorQuery.refetch();
          if (refreshed.isSuccess) recoverVerifiedConflict("update", refreshed.data);
        }
      } finally {
        onCommandFinish();
      }
    },
    onSuccess: async (editor) => {
      try {
        pendingUpdate.current = undefined;
        setPendingConflictRecovery(undefined);
        setConflictRemote(undefined);
        setFieldErrors({});
        setFormState(editorFormState(editor));
        await queryClient.cancelQueries({
          queryKey: studioQueryKeys.editor(userId, initialEditor.studioId),
        });
        try {
          publishStudioEditor(queryClient, editor, userId, initialEditor.studioId);
        } catch (error) {
          if (error instanceof StudioScopeChangedError) {
            recomposeStudioClientBoundary(queryClient);
            return;
          }
          throw error;
        }
        setSuccessMessage("Rascunho salvo com a versão canônica mais recente.");
        onAuthoritativeRevisionAdvance?.(editor);
      } finally {
        onCommandFinish();
      }
    },
  });

  const discardMutation = useMutation({
    mutationFn: () => {
      if (pendingDiscard.current === undefined) {
        throw new Error("O descarte não possui solicitação idempotente preparada.");
      }
      return discardStudioDraft(pendingDiscard.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isAmbiguousStudioError(error)) return;
      pendingDiscard.current = undefined;
      try {
        if (isStudioBoundaryChangedError(error)) {
          recomposeStudioClientBoundary(queryClient);
          return;
        }
        if (error instanceof StudioApiError && error.code === "CONFLICT") {
          setConfirmDiscard(false);
          setPendingConflictRecovery("discard");
          const refreshed = await editorQuery.refetch();
          if (refreshed.isSuccess) recoverVerifiedConflict("discard", refreshed.data);
        }
      } finally {
        onCommandFinish();
      }
    },
    onSuccess: async (result) => {
      try {
        pendingDiscard.current = undefined;
        setPendingConflictRecovery(undefined);
        setConfirmDiscard(false);
        if (result.studioDeleted) {
          await queryClient.cancelQueries({ exact: true, queryKey: editorQueryKey });
          queryClient.removeQueries({ exact: true, queryKey: editorQueryKey });
          setStudioDeleted(true);
          onStudioDeleted?.();
          return;
        }
        await queryClient.cancelQueries({
          queryKey: studioQueryKeys.editor(userId, initialEditor.studioId),
        });
        try {
          publishStudioEditor(queryClient, result.editor, userId, initialEditor.studioId);
        } catch (error) {
          if (error instanceof StudioScopeChangedError) {
            recomposeStudioClientBoundary(queryClient);
            return;
          }
          throw error;
        }
        setFormState(editorFormState(result.editor));
        setSuccessMessage("O rascunho foi descartado; a versão publicada permaneceu intacta.");
        onAuthoritativeRevisionReplacement?.(result.editor);
      } finally {
        onCommandFinish();
      }
    },
  });

  function updateField(field: keyof StudioCoreFormState, value: string) {
    setSuccessMessage(undefined);
    setFormState((current) => ({ ...current, [field]: value }));
  }

  function recoverVerifiedConflict(kind: "discard" | "update", editor: StudioEditor) {
    const revision = studioRevisionToken(editor);
    if (kind === "update") {
      setConflictRemote(editor);
    } else {
      onDiscardRevisionChange(revision);
    }
    setPendingConflictRecovery(undefined);
  }

  async function verifyEditor() {
    const refreshed = await editorQuery.refetch();
    if (pendingConflictRecovery !== undefined && refreshed.isSuccess) {
      recoverVerifiedConflict(pendingConflictRecovery, refreshed.data);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateMutation.reset();
    setFieldErrors({});
    setSuccessMessage(undefined);
    const parsed = parseCoreForm(formState);
    if (!parsed.success) {
      setFieldErrors(firstFieldErrors(parsed.error));
      return;
    }
    pendingUpdate.current = {
      action: "studio.revision.updateCore",
      expectedScope: userId,
      idempotencyKey: crypto.randomUUID(),
      payload: {
        ...parsed.data,
        expectedRevisionId: formRevision.id,
        expectedRevisionVersion: formRevision.version,
        studioId: initialEditor.studioId,
      },
    };
    onCommandStart();
    updateMutation.mutate();
  }

  function beginDiscard() {
    if (pendingDiscard.current === undefined) {
      pendingDiscard.current = {
        action: "studio.draft.discard",
        expectedScope: userId,
        idempotencyKey: crypto.randomUUID(),
        payload: {
          expectedRevisionId: discardRevision.id,
          expectedRevisionVersion: discardRevision.version,
          studioId: initialEditor.studioId,
        },
      };
    }
    onCommandStart();
    discardMutation.mutate();
  }

  function openDiscardConfirmation() {
    pendingDiscard.current = undefined;
    discardMutation.reset();
    setConfirmDiscard(true);
  }

  if (studioDeleted) {
    return (
      <Alert title="Rascunho descartado" variant="status">
        <Stack space={3}>
          <span>
            O cadastro removido não permanecerá no histórico de navegação. Abra um novo formulário
            para continuar.
          </span>
          <ButtonLink href="/dono/estudios/novo" variant="secondary">
            Abrir novo formulário
          </ButtonLink>
        </Stack>
      </Alert>
    );
  }

  const updateError = apiError(updateMutation.error);
  const discardError = apiError(discardMutation.error);
  const visibleErrors = updateError?.fieldErrors ?? fieldErrors;
  const types = typesQuery.data;
  const editor = editorQuery.data;
  const editorIsVerified =
    pendingConflictRecovery === undefined &&
    studioEditorCanRender(
      editor,
      userId,
      initialEditor.studioId,
      editorQuery.fetchStatus,
      editorQuery.isError,
    );
  const canEdit =
    editor.studioStatus !== "disabled" &&
    (editor.revision.status === "draft" ||
      (!editor.hasDraft && editor.revision.status === "approved"));
  const hasAmbiguousUpdate = updateError !== undefined && isAmbiguousStudioError(updateError);
  const hasAmbiguousDiscard = discardError !== undefined && isAmbiguousStudioError(discardError);
  const retryUpdate = hasAmbiguousUpdate ? () => updateMutation.mutate() : undefined;
  const retryDiscard = hasAmbiguousDiscard ? () => discardMutation.mutate() : undefined;
  const displayTypes = includeCurrentStudioType(types, editor.studioType);
  const conflictTypes = mergeStudioTypeDescriptors(
    [...initialTypes, ...displayTypes],
    [
      initialEditor.studioType,
      editor.studioType,
      ...(conflictRemote === undefined ? [] : [conflictRemote.studioType]),
    ],
  );
  const unavailableTypeId = types.some((type) => type.id === editor.studioType.id)
    ? undefined
    : editor.studioType.id;
  const selectedTypeIsUnavailable =
    formState.studioTypeId !== "" && !types.some((type) => type.id === formState.studioTypeId);
  const formLocked =
    !canEdit ||
    updateMutation.isPending ||
    discardMutation.isPending ||
    hasAmbiguousUpdate ||
    hasAmbiguousDiscard ||
    pendingConflictRecovery !== undefined ||
    externalCommandLocked ||
    typesQuery.fetchStatus === "fetching" ||
    typesQuery.isError;

  if (!editorIsVerified) {
    const verifying = editorQuery.fetchStatus === "fetching";
    return (
      <Alert
        title={verifying ? "Verificando o editor seguro" : "Não foi possível verificar o editor"}
        variant={verifying ? "status" : "error"}
      >
        <Stack space={3}>
          <span>
            {verifying
              ? "Os dados privados permanecerão ocultos até a confirmação autoritativa da sessão."
              : "Os dados privados continuam ocultos. Verifique novamente a sessão antes de editar."}
          </span>
          {verifying ? null : (
            <Button onClick={() => void verifyEditor()} variant="secondary">
              Verificar novamente
            </Button>
          )}
        </Stack>
      </Alert>
    );
  }

  return (
    <div className={styles.editorLayout}>
      <form className={styles.form} noValidate onSubmit={submit}>
        <StudioTypesFeedback
          loading={typesQuery.fetchStatus === "fetching"}
          onRetry={() => void typesQuery.refetch()}
          unavailable={typesQuery.isError}
        />
        <div className={styles.revisionSummary}>
          <strong>Revisão {formRevision.number}</strong>
          <span>Versão de edição {formRevision.version}</span>
          <span>{editor.hasDraft ? "Rascunho privado" : "Versão publicada aprovada"}</span>
        </div>
        {editor.studioStatus === "disabled" ? (
          <Alert title="Estúdio desabilitado" variant="error">
            Este estúdio foi desabilitado administrativamente e permanece somente para consulta.
            Nenhuma alteração ou descarte está disponível neste estado.
          </Alert>
        ) : !canEdit ? (
          <Alert title="Esta revisão não pode ser editada" variant="error">
            O estado atual é factual e imutável. Use a etapa de publicação para iniciar a próxima
            transição disponível.
          </Alert>
        ) : null}
        <StudioMutationFeedback error={updateError} onRetry={retryUpdate} />
        <StudioMutationFeedback error={discardError} onRetry={retryDiscard} />
        {successMessage === undefined ? null : (
          <Alert title="Alteração concluída" variant="status">
            {successMessage}
          </Alert>
        )}
        {conflictRemote === undefined ? null : (
          <StudioConflictComparison
            local={formState}
            onKeepLocal={() => {
              const revision = studioRevisionToken(conflictRemote);
              onFormRevisionChange(revision);
              setConflictRemote(undefined);
            }}
            onUseRemote={() => {
              setFormState(editorFormState(conflictRemote));
              const revision = studioRevisionToken(conflictRemote);
              onFormRevisionChange(revision);
              setConflictRemote(undefined);
            }}
            remote={editorFormState(conflictRemote)}
            studioTypes={conflictTypes}
          />
        )}
        {selectedTypeIsUnavailable ? (
          <Alert title="Tipo de estúdio arquivado" variant="error">
            O tipo histórico continua visível, mas não pode ser salvo em uma nova alteração. Escolha
            um tipo ativo para continuar.
          </Alert>
        ) : null}
        <StudioCoreFields
          {...(unavailableTypeId === undefined ? {} : { unavailableTypeId })}
          disabled={formLocked}
          errors={visibleErrors}
          onChange={updateField}
          state={formState}
          types={displayTypes}
        />
        <div className={styles.actions}>
          <Button
            disabled={
              formLocked ||
              types.length === 0 ||
              formState.studioTypeId === "" ||
              selectedTypeIsUnavailable
            }
            loading={updateMutation.isPending}
            loadingLabel="Salvando revisão"
            type="submit"
          >
            {editor.hasDraft ? "Salvar rascunho" : "Criar rascunho e salvar"}
          </Button>
          {canEdit && editor.hasDraft && editor.revision.status === "draft" ? (
            <Button disabled={formLocked} onClick={openDiscardConfirmation} variant="ghost">
              Descartar rascunho
            </Button>
          ) : null}
        </div>
        {confirmDiscard ? (
          <div className={styles.discardConfirmation} role="group" aria-label="Confirmar descarte">
            <p>
              {editor.publishedRevisionId === null
                ? "Este estúdio ainda não foi publicado; descartar removerá o cadastro em rascunho."
                : "Somente o rascunho será removido. A versão publicada continuará disponível."}
            </p>
            <div className={styles.actions}>
              <Button
                disabled={hasAmbiguousDiscard}
                loading={discardMutation.isPending}
                loadingLabel="Descartando"
                onClick={beginDiscard}
                variant="secondary"
              >
                Confirmar descarte
              </Button>
              <Button
                disabled={discardMutation.isPending || hasAmbiguousDiscard}
                onClick={() => setConfirmDiscard(false)}
                variant="ghost"
              >
                Manter rascunho
              </Button>
            </div>
          </div>
        ) : null}
      </form>
      <StudioLocalPreview state={formState} types={displayTypes} />
    </div>
  );
}

export function StudioCorePanel(
  props: Readonly<
    | { initialTypes: readonly StudioTypeOption[]; mode: "create"; userId: string }
    | {
        discardRevision: StudioRevisionToken;
        externalCommandLocked: boolean;
        formRevision: StudioRevisionToken;
        initialEditor: StudioEditor;
        initialTypes: readonly StudioTypeOption[];
        mode: "edit";
        onAuthoritativeRevisionAdvance?: (editor: StudioEditor) => void;
        onAuthoritativeRevisionReplacement?: (editor: StudioEditor) => void;
        onCommandFinish: () => void;
        onCommandStart: () => void;
        onDiscardRevisionChange: (revision: StudioRevisionToken) => void;
        onFormRevisionChange: (revision: StudioRevisionToken) => void;
        onStudioDeleted?: () => void;
        userId: string;
      }
  >,
) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <Alert title="Preparando o editor seguro" variant="status">
        Aguarde enquanto conectamos os controles interativos desta página.
      </Alert>
    );
  }
  return props.mode === "create" ? (
    <CreateStudioForm initialTypes={props.initialTypes} userId={props.userId} />
  ) : (
    <EditStudioForm
      discardRevision={props.discardRevision}
      externalCommandLocked={props.externalCommandLocked}
      formRevision={props.formRevision}
      initialEditor={props.initialEditor}
      initialTypes={props.initialTypes}
      onAuthoritativeRevisionAdvance={props.onAuthoritativeRevisionAdvance}
      onAuthoritativeRevisionReplacement={props.onAuthoritativeRevisionReplacement}
      onCommandFinish={props.onCommandFinish}
      onCommandStart={props.onCommandStart}
      onDiscardRevisionChange={props.onDiscardRevisionChange}
      onFormRevisionChange={props.onFormRevisionChange}
      onStudioDeleted={props.onStudioDeleted}
      userId={props.userId}
    />
  );
}

export const studioCorePanelInternals = {
  conflictRows,
  editorFormState,
  includeCurrentStudioType,
  parseCoreForm,
};
