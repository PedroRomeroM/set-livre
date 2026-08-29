"use client";

import {
  formatStudioPostalCode,
  studioCorePayloadSchema,
  type StudioEditor,
  type StudioTypeOption,
} from "@set-livre/contracts";
import { Alert, Button, Field, Input, Select, Stack, Textarea } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";

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
import { publishStudioEditor, StudioScopeChangedError, studioQueryKeys } from "./studio-query-keys";
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
  disabled,
  errors,
  onChange,
  state,
  types,
}: Readonly<{
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
                <option key={type.id} value={type.id}>
                  {type.name}
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

function CreateStudioForm({
  initialTypes,
  userId,
}: Readonly<{ initialTypes: readonly StudioTypeOption[]; userId: string }>) {
  const router = useRouter();
  const typesQuery = useStudioTypes(initialTypes);
  const pendingCommand = useRef<CreateCommand>(undefined);
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
    onError: (error) => {
      if (isStudioBoundaryChangedError(error)) router.refresh();
    },
    onSuccess: (editor) => {
      setSuccessMessage("Rascunho criado. Abrindo o editor canônico.");
      pendingCommand.current = undefined;
      router.push(`/dono/estudios/${editor.studioId}/dados`);
    },
  });

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
  const retry =
    error !== undefined && isAmbiguousStudioError(error) ? () => mutation.mutate() : undefined;
  const types = typesQuery.data;

  return (
    <div className={styles.editorLayout}>
      <form className={styles.form} noValidate onSubmit={submit}>
        {types.length === 0 ? (
          <Alert title="Nenhum tipo de estúdio está disponível" variant="error">
            A taxonomia precisa ser reativada por um administrador antes de criar um estúdio.
          </Alert>
        ) : null}
        <StudioMutationFeedback error={error} onRetry={retry} />
        {successMessage === undefined ? null : (
          <Alert title="Estúdio salvo" variant="status">
            {successMessage}
          </Alert>
        )}
        <StudioCoreFields
          disabled={mutation.isPending}
          errors={visibleErrors}
          onChange={updateField}
          state={formState}
          types={types}
        />
        <div className={styles.actions}>
          <Button
            disabled={types.length === 0}
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

function conflictRows(local: StudioCoreFormState, remote: StudioCoreFormState) {
  return (Object.keys(fieldLabels) as Array<keyof StudioCoreFormState>)
    .filter((field) => local[field] !== remote[field])
    .map((field) => ({
      field,
      label: fieldLabels[field],
      local: local[field],
      remote: remote[field],
    }));
}

function StudioConflictComparison({
  local,
  onKeepLocal,
  onUseRemote,
  remote,
}: Readonly<{
  local: StudioCoreFormState;
  onKeepLocal: () => void;
  onUseRemote: () => void;
  remote: StudioCoreFormState;
}>) {
  const rows = useMemo(() => conflictRows(local, remote), [local, remote]);
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
              <span role="cell">{row.local || "—"}</span>
              <span role="cell">{row.remote || "—"}</span>
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
  initialEditor,
  initialTypes,
  userId,
}: Readonly<{
  initialEditor: StudioEditor;
  initialTypes: readonly StudioTypeOption[];
  userId: string;
}>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const typesQuery = useStudioTypes(initialTypes);
  const editorQuery = useQuery({
    initialData: initialEditor,
    queryFn: ({ signal }) => readStudioEditor(initialEditor.studioId, signal),
    queryKey: studioQueryKeys.editor(userId, initialEditor.studioId),
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

  const updateMutation = useMutation({
    mutationFn: () => {
      if (pendingUpdate.current === undefined) {
        throw new Error("A atualização não possui solicitação idempotente preparada.");
      }
      return updateStudioCore(pendingUpdate.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isStudioBoundaryChangedError(error)) {
        router.refresh();
        return;
      }
      if (error instanceof StudioApiError && error.code === "CONFLICT") {
        const refreshed = await editorQuery.refetch();
        if (refreshed.data !== undefined) setConflictRemote(refreshed.data);
      }
    },
    onSuccess: async (editor) => {
      pendingUpdate.current = undefined;
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
          router.refresh();
          return;
        }
        throw error;
      }
      setSuccessMessage("Rascunho salvo com a versão canônica mais recente.");
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
    onError: (error) => {
      if (isStudioBoundaryChangedError(error)) router.refresh();
    },
    onSuccess: async (result) => {
      pendingDiscard.current = undefined;
      setConfirmDiscard(false);
      if (result.studioDeleted) {
        queryClient.removeQueries({ queryKey: studioQueryKeys.privateEditors });
        router.push("/dono/estudios/novo");
        return;
      }
      await queryClient.cancelQueries({
        queryKey: studioQueryKeys.editor(userId, initialEditor.studioId),
      });
      try {
        publishStudioEditor(queryClient, result.editor, userId, initialEditor.studioId);
      } catch (error) {
        if (error instanceof StudioScopeChangedError) {
          router.refresh();
          return;
        }
        throw error;
      }
      setFormState(editorFormState(result.editor));
      setSuccessMessage("O rascunho foi descartado; a versão publicada permaneceu intacta.");
    },
  });

  function updateField(field: keyof StudioCoreFormState, value: string) {
    setFormState((current) => ({ ...current, [field]: value }));
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
    const editor = editorQuery.data;
    pendingUpdate.current = {
      action: "studio.revision.updateCore",
      expectedScope: userId,
      idempotencyKey: crypto.randomUUID(),
      payload: {
        ...parsed.data,
        expectedRevisionId: editor.revision.id,
        expectedRevisionVersion: editor.revision.version,
        studioId: editor.studioId,
      },
    };
    updateMutation.mutate();
  }

  function beginDiscard() {
    const editor = editorQuery.data;
    pendingDiscard.current = {
      action: "studio.draft.discard",
      expectedScope: userId,
      idempotencyKey: crypto.randomUUID(),
      payload: {
        expectedRevisionId: editor.revision.id,
        expectedRevisionVersion: editor.revision.version,
        studioId: editor.studioId,
      },
    };
    discardMutation.mutate();
  }

  const updateError = apiError(updateMutation.error);
  const discardError = apiError(discardMutation.error);
  const visibleErrors = updateError?.fieldErrors ?? fieldErrors;
  const types = typesQuery.data;
  const editor = editorQuery.data;
  const canEdit =
    editor.revision.status === "draft" ||
    (!editor.hasDraft && editor.revision.status === "approved");
  const retryUpdate =
    updateError !== undefined && isAmbiguousStudioError(updateError)
      ? () => updateMutation.mutate()
      : undefined;
  const retryDiscard =
    discardError !== undefined && isAmbiguousStudioError(discardError)
      ? () => discardMutation.mutate()
      : undefined;

  return (
    <div className={styles.editorLayout}>
      <form className={styles.form} noValidate onSubmit={submit}>
        <div className={styles.revisionSummary}>
          <strong>Revisão {editor.revision.number}</strong>
          <span>Versão de edição {editor.revision.version}</span>
          <span>{editor.hasDraft ? "Rascunho privado" : "Versão publicada aprovada"}</span>
        </div>
        {!canEdit ? (
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
            onKeepLocal={() => setConflictRemote(undefined)}
            onUseRemote={() => {
              setFormState(editorFormState(conflictRemote));
              setConflictRemote(undefined);
            }}
            remote={editorFormState(conflictRemote)}
          />
        )}
        <StudioCoreFields
          disabled={!canEdit || updateMutation.isPending || discardMutation.isPending}
          errors={visibleErrors}
          onChange={updateField}
          state={formState}
          types={types}
        />
        <div className={styles.actions}>
          <Button
            disabled={!canEdit || types.length === 0}
            loading={updateMutation.isPending}
            loadingLabel="Salvando revisão"
            type="submit"
          >
            {editor.hasDraft ? "Salvar rascunho" : "Criar rascunho e salvar"}
          </Button>
          {editor.hasDraft && editor.revision.status === "draft" ? (
            <Button onClick={() => setConfirmDiscard(true)} variant="ghost">
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
                loading={discardMutation.isPending}
                loadingLabel="Descartando"
                onClick={beginDiscard}
                variant="secondary"
              >
                Confirmar descarte
              </Button>
              <Button
                disabled={discardMutation.isPending}
                onClick={() => setConfirmDiscard(false)}
                variant="ghost"
              >
                Manter rascunho
              </Button>
            </div>
          </div>
        ) : null}
      </form>
      <StudioLocalPreview state={formState} types={types} />
    </div>
  );
}

export function StudioCorePanel(
  props: Readonly<
    | { initialTypes: readonly StudioTypeOption[]; mode: "create"; userId: string }
    | {
        initialEditor: StudioEditor;
        initialTypes: readonly StudioTypeOption[];
        mode: "edit";
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
      initialEditor={props.initialEditor}
      initialTypes={props.initialTypes}
      userId={props.userId}
    />
  );
}

export const studioCorePanelInternals = {
  conflictRows,
  editorFormState,
  parseCoreForm,
};
