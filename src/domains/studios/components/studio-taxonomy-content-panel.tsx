"use client";

import {
  parseStudioYoutubeVideoId,
  studioContentPayloadSchema,
  studioEditorSchema,
  studioTaxonomyPayloadSchema,
  studioYoutubeVideoInputSchema,
  type StudioCommand,
  type StudioEditor,
  type StudioFaqInput,
  type StudioTaxonomies,
  type StudioTaxonomyOption,
  type StudioTaxonomyReference,
} from "@set-livre/contracts";
import { Alert, Button, Checkbox, Field, Input, Stack, Textarea } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { useHydrated } from "@/lib/client/use-hydrated";

import {
  isAmbiguousStudioError,
  isStudioBoundaryChangedError,
  readStudioEditor,
  readStudioTaxonomies,
  StudioApiError,
  updateStudioContent,
  updateStudioTaxonomy,
} from "./studio-api";
import {
  assertStudioEditorBoundary,
  preserveNewestStudioEditor,
  publishAuthoritativeStudioEditor,
  publishStudioEditorAfterPendingRead,
  recomposeStudioClientBoundary,
  studioEditorCanRender,
  studioRevisionToken,
  StudioScopeChangedError,
  studioQueryKeys,
  type StudioRevisionToken,
} from "./studio-query-keys";
import styles from "./studio.module.css";

type FieldErrors = Readonly<Record<string, string>>;
type TaxonomyCommand = Extract<StudioCommand, { action: "studio.revision.updateTaxonomy" }>;
type ContentCommand = Extract<StudioCommand, { action: "studio.revision.updateContent" }>;
type PendingEditorCommand<T> = Readonly<{ command: T; expectedEditor: StudioEditor }>;
type FaqDraft = StudioFaqInput & { key: string };
type CommercialConflictKind = "content" | "taxonomy";

type CommercialConflictState = Readonly<{
  failedReads: readonly ("editor" | "taxonomies")[];
  kind: CommercialConflictKind;
  pending: boolean;
  remote?: StudioEditor;
}>;

function searchable(value: string) {
  return value
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function issueErrors(issues: readonly { message: string; path: PropertyKey[] }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".");
    if (key !== "" && errors[key] === undefined) errors[key] = issue.message;
  }
  return errors;
}

function apiError(error: unknown) {
  return error instanceof StudioApiError ? error : undefined;
}

function fieldErrorProp(errors: FieldErrors, field: string) {
  const error = errors[field];
  return error === undefined ? {} : { error };
}

function editorFaqs(editor: StudioEditor): FaqDraft[] {
  return editor.revision.faqs.map((faq) => ({
    answer: faq.answer,
    key: faq.id,
    question: faq.question,
  }));
}

function taxonomyIds(references: readonly StudioTaxonomyReference[]) {
  return references.map((reference) => reference.id);
}

function activeTaxonomyReferences(
  options: readonly StudioTaxonomyOption[],
): StudioTaxonomyReference[] {
  return options.map((option) => ({ ...option, active: true }));
}

function mergeKnownTaxonomies(
  current: readonly StudioTaxonomyReference[],
  additions: readonly StudioTaxonomyReference[],
) {
  const merged = new Map(current.map((reference) => [reference.id, reference]));
  for (const reference of additions) merged.set(reference.id, reference);
  return [...merged.values()];
}

function selectableTaxonomies(
  known: readonly StudioTaxonomyReference[],
  active: readonly StudioTaxonomyOption[],
  selectedIds: readonly string[],
  authoritative: readonly StudioTaxonomyReference[],
) {
  const choices = new Map(
    known.map((reference) => [reference.id, { ...reference, active: false }]),
  );
  for (const reference of authoritative) choices.set(reference.id, reference);
  for (const option of active) choices.set(option.id, { ...option, active: true });
  return [...choices.values()]
    .filter((choice) => choice.active || selectedIds.includes(choice.id))
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name, "pt-BR") ||
        left.id.localeCompare(right.id),
    );
}

function taxonomyNames(ids: readonly string[], choices: readonly StudioTaxonomyReference[]) {
  const names = new Map(choices.map((choice) => [choice.id, choice.name]));
  return ids.map((id) => names.get(id) ?? "Opção indisponível").join(", ") || "Nenhuma";
}

function StudioCommandFeedback({
  error,
  onRetry,
}: Readonly<{ error: StudioApiError | undefined; onRetry: (() => void) | undefined }>) {
  if (error === undefined) return null;
  return (
    <Alert
      title={
        error.code === "CONFLICT" ? "O conteúdo mudou em outro lugar" : "Não foi possível salvar"
      }
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

function TaxonomySelector({
  disabled,
  label,
  onChange,
  options,
  selectedIds,
}: Readonly<{
  disabled: boolean;
  label: string;
  onChange: (ids: string[]) => void;
  options: readonly StudioTaxonomyReference[];
  selectedIds: readonly string[];
}>) {
  const [search, setSearch] = useState("");
  const normalizedSearch = searchable(search.trim());
  const visible = useMemo(
    () =>
      normalizedSearch === ""
        ? options
        : options.filter((option) => searchable(option.name).includes(normalizedSearch)),
    [normalizedSearch, options],
  );

  function toggle(id: string, selected: boolean) {
    onChange(
      selected ? [...selectedIds, id] : selectedIds.filter((selectedId) => selectedId !== id),
    );
  }

  return (
    <fieldset className={styles.taxonomyGroup} disabled={disabled}>
      <legend className={styles.sectionTitle}>{label}</legend>
      <p className={styles.sectionDescription}>{selectedIds.length} de 20 selecionadas</p>
      <Field label={`Buscar em ${label.toLocaleLowerCase("pt-BR")}`}>
        <Input
          onChange={(event) => setSearch(event.currentTarget.value)}
          type="search"
          value={search}
        />
      </Field>
      <div className={styles.taxonomyOptions}>
        {visible.length === 0 ? (
          <p className={styles.sectionDescription}>Nenhuma opção corresponde à busca.</p>
        ) : (
          visible.map((option) => {
            const checked = selectedIds.includes(option.id);
            return (
              <Checkbox
                checked={checked}
                disabled={!checked && (!option.active || selectedIds.length >= 20)}
                key={option.id}
                label={`${option.name}${option.active ? "" : " — arquivada"}`}
                onChange={(event) => toggle(option.id, event.currentTarget.checked)}
              />
            );
          })
        )}
      </div>
    </fieldset>
  );
}

function FaqEditor({
  disabled,
  errors,
  faqs,
  onChange,
}: Readonly<{
  disabled: boolean;
  errors: FieldErrors;
  faqs: readonly FaqDraft[];
  onChange: (faqs: FaqDraft[]) => void;
}>) {
  function update(index: number, field: "answer" | "question", value: string) {
    onChange(faqs.map((faq, faqIndex) => (faqIndex === index ? { ...faq, [field]: value } : faq)));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= faqs.length) return;
    const reordered = [...faqs];
    const current = reordered[index];
    const adjacent = reordered[target];
    if (current === undefined || adjacent === undefined) return;
    reordered[index] = adjacent;
    reordered[target] = current;
    onChange(reordered);
  }

  return (
    <section aria-labelledby="studio-faq-title" className={styles.formSection}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle} id="studio-faq-title">
          Perguntas frequentes
        </h3>
        <p className={styles.sectionDescription}>
          Até 20 pares de pergunta e resposta; a ordem abaixo será a ordem pública após aprovação.
        </p>
      </div>
      {faqs.map((faq, index) => (
        <div className={styles.faqItem} key={faq.key}>
          <div className={styles.faqHeader}>
            <strong>FAQ {index + 1}</strong>
            <div className={styles.compactActions}>
              <Button
                aria-label={`Mover FAQ ${index + 1} para cima`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
                variant="ghost"
              >
                Subir
              </Button>
              <Button
                aria-label={`Mover FAQ ${index + 1} para baixo`}
                disabled={disabled || index === faqs.length - 1}
                onClick={() => move(index, 1)}
                variant="ghost"
              >
                Descer
              </Button>
              <Button
                aria-label={`Excluir FAQ ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(faqs.filter((_, faqIndex) => faqIndex !== index))}
                variant="ghost"
              >
                Excluir
              </Button>
            </div>
          </div>
          <Field
            {...fieldErrorProp(errors, `faqs.${index}.question`)}
            label={`Pergunta ${index + 1}`}
            required
          >
            <Input
              disabled={disabled}
              maxLength={160}
              onChange={(event) => update(index, "question", event.currentTarget.value)}
              value={faq.question}
            />
          </Field>
          <Field
            {...fieldErrorProp(errors, `faqs.${index}.answer`)}
            label={`Resposta ${index + 1}`}
            required
          >
            <Textarea
              disabled={disabled}
              maxLength={2000}
              onChange={(event) => update(index, "answer", event.currentTarget.value)}
              rows={5}
              value={faq.answer}
            />
          </Field>
        </div>
      ))}
      <Button
        disabled={disabled || faqs.length >= 20}
        onClick={() => onChange([...faqs, { answer: "", key: crypto.randomUUID(), question: "" }])}
        variant="secondary"
      >
        Adicionar pergunta
      </Button>
    </section>
  );
}

function ConflictRecoveryFeedback({
  conflict,
  onRetry,
}: Readonly<{
  conflict: CommercialConflictState | undefined;
  onRetry: () => void;
}>) {
  if (conflict === undefined || conflict.remote !== undefined) return null;
  if (conflict.pending) {
    return (
      <Alert title="Carregando a versão salva" variant="status">
        Os valores locais permanecem preservados até a comparação autoritativa terminar.
      </Alert>
    );
  }
  return (
    <Alert title="Não foi possível carregar a comparação" variant="error">
      <Stack space={3}>
        <span>
          Falharam: {conflict.failedReads.join(" e ")}. Nenhum token de edição foi atualizado.
        </span>
        <Button onClick={onRetry} variant="secondary">
          Tentar carregar a comparação novamente
        </Button>
      </Stack>
    </Alert>
  );
}

function ConflictValue({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <span role="cell">
      <span aria-hidden="true" className={styles.mobileConflictLabel}>
        {label}
      </span>
      <span>{value}</span>
    </span>
  );
}

function faqComparisonText(faqs: readonly { answer: string; question: string }[]) {
  if (faqs.length === 0) return "Nenhuma";
  return faqs
    .map((faq, index) => {
      const question = faq.question.trim() || "Pergunta sem texto";
      const answer = faq.answer.trim() || "Resposta sem texto";
      return `${index + 1}. ${question}\nResposta: ${answer}`;
    })
    .join("\n\n");
}

function TaxonomyConflictComparison({
  amenityChoices,
  localAmenityIds,
  localTagIds,
  onKeepLocal,
  onUseRemote,
  remote,
  tagChoices,
}: Readonly<{
  amenityChoices: readonly StudioTaxonomyReference[];
  localAmenityIds: readonly string[];
  localTagIds: readonly string[];
  onKeepLocal: () => void;
  onUseRemote: () => void;
  remote: StudioEditor;
  tagChoices: readonly StudioTaxonomyReference[];
}>) {
  const allTags = mergeKnownTaxonomies(tagChoices, remote.revision.tags);
  const allAmenities = mergeKnownTaxonomies(amenityChoices, remote.revision.amenities);
  return (
    <section aria-labelledby="studio-taxonomy-conflict-title" className={styles.conflict}>
      <h3 className={styles.sectionTitle} id="studio-taxonomy-conflict-title">
        Compare as taxonomias antes de continuar
      </h3>
      <p className={styles.sectionDescription}>
        O token só será atualizado após sua escolha. Itens arquivados continuam visíveis para
        remoção, mas não podem ser incluídos em uma nova gravação.
      </p>
      <div className={styles.conflictTable} role="table" aria-label="Comparação de taxonomias">
        <div className={styles.conflictHeader} role="row">
          <span role="columnheader">Grupo</span>
          <span role="columnheader">Sua versão</span>
          <span role="columnheader">Versão salva</span>
        </div>
        <div className={styles.conflictRow} role="row">
          <strong role="cell">Tags</strong>
          <ConflictValue label="Sua versão" value={taxonomyNames(localTagIds, allTags)} />
          <ConflictValue
            label="Versão salva"
            value={taxonomyNames(taxonomyIds(remote.revision.tags), allTags)}
          />
        </div>
        <div className={styles.conflictRow} role="row">
          <strong role="cell">Comodidades</strong>
          <ConflictValue label="Sua versão" value={taxonomyNames(localAmenityIds, allAmenities)} />
          <ConflictValue
            label="Versão salva"
            value={taxonomyNames(taxonomyIds(remote.revision.amenities), allAmenities)}
          />
        </div>
      </div>
      <div className={styles.actions}>
        <Button onClick={onUseRemote} variant="secondary">
          Usar taxonomias salvas
        </Button>
        <Button onClick={onKeepLocal}>Continuar com minhas seleções</Button>
      </div>
    </section>
  );
}

function ContentConflictComparison({
  faqs,
  onKeepLocal,
  onUseRemote,
  remote,
  usageRules,
  youtubeInput,
}: Readonly<{
  faqs: readonly FaqDraft[];
  onKeepLocal: () => void;
  onUseRemote: () => void;
  remote: StudioEditor;
  usageRules: string;
  youtubeInput: string;
}>) {
  const localFaqs = faqComparisonText(faqs);
  const remoteFaqs = faqComparisonText(remote.revision.faqs);
  return (
    <section aria-labelledby="studio-content-conflict-title" className={styles.conflict}>
      <h3 className={styles.sectionTitle} id="studio-content-conflict-title">
        Compare o conteúdo antes de continuar
      </h3>
      <p className={styles.sectionDescription}>
        Nada será sobrescrito até você escolher qual base usar para a próxima tentativa.
      </p>
      <div className={styles.conflictTable} role="table" aria-label="Comparação de conteúdo">
        <div className={styles.conflictHeader} role="row">
          <span role="columnheader">Campo</span>
          <span role="columnheader">Sua versão</span>
          <span role="columnheader">Versão salva</span>
        </div>
        <div className={styles.conflictRow} role="row">
          <strong role="cell">Regras</strong>
          <ConflictValue label="Sua versão" value={usageRules || "Sem regras"} />
          <ConflictValue label="Versão salva" value={remote.revision.usageRules || "Sem regras"} />
        </div>
        <div className={styles.conflictRow} role="row">
          <strong role="cell">Vídeo</strong>
          <ConflictValue label="Sua versão" value={youtubeInput || "Sem vídeo"} />
          <ConflictValue
            label="Versão salva"
            value={remote.revision.youtubeVideoId ?? "Sem vídeo"}
          />
        </div>
        <div className={styles.conflictRow} role="row">
          <strong role="cell">Perguntas e respostas</strong>
          <ConflictValue label="Sua versão" value={localFaqs} />
          <ConflictValue label="Versão salva" value={remoteFaqs} />
        </div>
      </div>
      <div className={styles.actions}>
        <Button onClick={onUseRemote} variant="secondary">
          Usar conteúdo salvo
        </Button>
        <Button onClick={onKeepLocal}>Continuar com meu conteúdo</Button>
      </div>
    </section>
  );
}

export function StudioTaxonomyContentPanel({
  contentRevision,
  externalCommandLocked,
  initialEditor,
  initialTaxonomies,
  onCommandFinish,
  onCommandStart,
  onContentRevisionChange,
  onContentSave,
  onTaxonomyRevisionChange,
  onTaxonomySave,
  taxonomyRevision,
  userId,
}: Readonly<{
  contentRevision: StudioRevisionToken;
  externalCommandLocked: boolean;
  initialEditor: StudioEditor;
  initialTaxonomies: StudioTaxonomies;
  onCommandFinish: () => void;
  onCommandStart: () => void;
  onContentRevisionChange: (revision: StudioRevisionToken) => void;
  onContentSave: (editor: StudioEditor, commandRevision: StudioRevisionToken) => void;
  onTaxonomyRevisionChange: (revision: StudioRevisionToken) => void;
  onTaxonomySave: (editor: StudioEditor, commandRevision: StudioRevisionToken) => void;
  taxonomyRevision: StudioRevisionToken;
  userId: string;
}>) {
  const hydrated = useHydrated();
  const queryClient = useQueryClient();
  const editorQueryKey = useMemo(
    () => studioQueryKeys.editor(userId, initialEditor.studioId),
    [initialEditor.studioId, userId],
  );
  const editorQuery = useQuery({
    enabled: hydrated,
    initialData: initialEditor,
    networkMode: "always",
    queryFn: async ({ signal }) =>
      assertStudioEditorBoundary(
        await readStudioEditor(initialEditor.studioId, signal),
        userId,
        initialEditor.studioId,
      ),
    queryKey: editorQueryKey,
    refetchOnMount: "always",
    refetchOnReconnect: true,
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 0,
    structuralSharing: (current, candidate) =>
      preserveNewestStudioEditor(
        current === undefined ? undefined : studioEditorSchema.parse(current),
        studioEditorSchema.parse(candidate),
        userId,
        initialEditor.studioId,
      ),
  });
  const editorIsVerified =
    hydrated &&
    studioEditorCanRender(
      editorQuery.data,
      userId,
      initialEditor.studioId,
      editorQuery.fetchStatus,
      editorQuery.isError,
    );
  const taxonomiesQuery = useQuery({
    enabled: editorIsVerified,
    initialData: initialTaxonomies,
    networkMode: "always",
    queryFn: ({ signal }) => readStudioTaxonomies(signal),
    queryKey: studioQueryKeys.taxonomies(userId),
    refetchOnMount: "always",
    refetchOnReconnect: true,
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 0,
  });
  const pendingTaxonomy = useRef<PendingEditorCommand<TaxonomyCommand>>(undefined);
  const pendingContent = useRef<PendingEditorCommand<ContentCommand>>(undefined);
  const [knownTags, setKnownTags] = useState(() =>
    mergeKnownTaxonomies(
      activeTaxonomyReferences(initialTaxonomies.tags),
      initialEditor.revision.tags,
    ),
  );
  const [knownAmenities, setKnownAmenities] = useState(() =>
    mergeKnownTaxonomies(
      activeTaxonomyReferences(initialTaxonomies.amenities),
      initialEditor.revision.amenities,
    ),
  );
  const [tagIds, setTagIds] = useState(() => taxonomyIds(initialEditor.revision.tags));
  const [amenityIds, setAmenityIds] = useState(() => taxonomyIds(initialEditor.revision.amenities));
  const [usageRules, setUsageRules] = useState(initialEditor.revision.usageRules);
  const [youtubeInput, setYoutubeInput] = useState(initialEditor.revision.youtubeVideoId ?? "");
  const [faqs, setFaqs] = useState(() => editorFaqs(initialEditor));
  const [taxonomyErrors, setTaxonomyErrors] = useState<FieldErrors>({});
  const [contentErrors, setContentErrors] = useState<FieldErrors>({});
  const [taxonomyStatus, setTaxonomyStatus] = useState<string>();
  const [contentStatus, setContentStatus] = useState<string>();
  const [conflict, setConflict] = useState<CommercialConflictState>();

  useEffect(() => {
    if (
      editorQuery.error instanceof StudioScopeChangedError ||
      isStudioBoundaryChangedError(editorQuery.error) ||
      isStudioBoundaryChangedError(taxonomiesQuery.error)
    ) {
      recomposeStudioClientBoundary(queryClient);
    }
  }, [editorQuery.error, queryClient, taxonomiesQuery.error]);

  async function publishCommand(editor: StudioEditor, expectedEditor: StudioEditor) {
    try {
      return await publishStudioEditorAfterPendingRead(
        queryClient,
        editor,
        expectedEditor,
        userId,
        initialEditor.studioId,
      );
    } catch (error) {
      if (error instanceof StudioScopeChangedError) {
        recomposeStudioClientBoundary(queryClient);
        return undefined;
      }
      throw error;
    }
  }

  function publishAuthoritative(editor: StudioEditor) {
    try {
      return publishAuthoritativeStudioEditor(queryClient, editor, userId, initialEditor.studioId);
    } catch (error) {
      if (error instanceof StudioScopeChangedError) {
        recomposeStudioClientBoundary(queryClient);
        return undefined;
      }
      throw error;
    }
  }

  async function recoverConflict(kind: CommercialConflictKind) {
    setConflict({ failedReads: [], kind, pending: true });
    const [editorResult, taxonomiesResult] = await Promise.allSettled([
      readStudioEditor(initialEditor.studioId).then((editor) =>
        assertStudioEditorBoundary(editor, userId, initialEditor.studioId),
      ),
      kind === "taxonomy" ? readStudioTaxonomies() : Promise.resolve(undefined),
    ]);
    const rejected = [editorResult, taxonomiesResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (
      rejected.some(
        (error) => error instanceof StudioScopeChangedError || isStudioBoundaryChangedError(error),
      )
    ) {
      recomposeStudioClientBoundary(queryClient);
      return;
    }
    const failedReads: ("editor" | "taxonomies")[] = [];
    if (editorResult.status === "rejected") failedReads.push("editor");
    if (taxonomiesResult.status === "rejected") failedReads.push("taxonomies");
    if (failedReads.length > 0 || editorResult.status === "rejected") {
      setConflict({ failedReads, kind, pending: false });
      return;
    }
    const published = publishAuthoritative(editorResult.value);
    if (published === undefined) return;
    if (kind === "taxonomy" && taxonomiesResult.status === "fulfilled") {
      queryClient.setQueryData(studioQueryKeys.taxonomies(userId), taxonomiesResult.value);
    }
    setConflict({ failedReads: [], kind, pending: false, remote: published });
  }

  const taxonomyMutation = useMutation({
    mutationFn: () => {
      if (pendingTaxonomy.current === undefined) {
        throw new Error("A taxonomia não possui solicitação idempotente preparada.");
      }
      return updateStudioTaxonomy(pendingTaxonomy.current.command);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isAmbiguousStudioError(error)) return;
      pendingTaxonomy.current = undefined;
      try {
        if (isStudioBoundaryChangedError(error)) {
          recomposeStudioClientBoundary(queryClient);
        } else if (
          error instanceof StudioApiError &&
          ["CONFLICT", "STUDIO_TAXONOMY_UNAVAILABLE"].includes(error.code)
        ) {
          await recoverConflict("taxonomy");
        }
      } finally {
        onCommandFinish();
      }
    },
    onSuccess: async (editor) => {
      try {
        const pending = pendingTaxonomy.current;
        if (pending === undefined) {
          throw new Error("A taxonomia perdeu a evidência causal do editor.");
        }
        pendingTaxonomy.current = undefined;
        const published = await publishCommand(editor, pending.expectedEditor);
        if (published === undefined) return;
        setTagIds(taxonomyIds(published.revision.tags));
        setAmenityIds(taxonomyIds(published.revision.amenities));
        setKnownTags((current) => mergeKnownTaxonomies(current, published.revision.tags));
        setKnownAmenities((current) => mergeKnownTaxonomies(current, published.revision.amenities));
        setConflict(undefined);
        setTaxonomyStatus("Tags e comodidades foram salvas na revisão em rascunho.");
        onTaxonomySave(published, studioRevisionToken(editor));
      } finally {
        onCommandFinish();
      }
    },
  });

  const contentMutation = useMutation({
    mutationFn: () => {
      if (pendingContent.current === undefined) {
        throw new Error("O conteúdo não possui solicitação idempotente preparada.");
      }
      return updateStudioContent(pendingContent.current.command);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isAmbiguousStudioError(error)) return;
      pendingContent.current = undefined;
      try {
        if (isStudioBoundaryChangedError(error)) {
          recomposeStudioClientBoundary(queryClient);
        } else if (error instanceof StudioApiError && error.code === "CONFLICT") {
          await recoverConflict("content");
        }
      } finally {
        onCommandFinish();
      }
    },
    onSuccess: async (editor) => {
      try {
        const pending = pendingContent.current;
        if (pending === undefined) {
          throw new Error("O conteúdo perdeu a evidência causal do editor.");
        }
        pendingContent.current = undefined;
        const published = await publishCommand(editor, pending.expectedEditor);
        if (published === undefined) return;
        setUsageRules(published.revision.usageRules);
        setYoutubeInput(published.revision.youtubeVideoId ?? "");
        setFaqs(editorFaqs(published));
        setConflict(undefined);
        setContentStatus("Regras, FAQ e vídeo foram salvos na revisão em rascunho.");
        onContentSave(published, studioRevisionToken(editor));
      } finally {
        onCommandFinish();
      }
    },
  });

  function changeTaxonomy(
    kind: "amenities" | "tags",
    setter: (ids: string[]) => void,
    ids: string[],
  ) {
    if (kind === "tags") {
      setKnownTags((current) =>
        mergeKnownTaxonomies(current, activeTaxonomyReferences(taxonomiesQuery.data.tags)),
      );
    } else {
      setKnownAmenities((current) =>
        mergeKnownTaxonomies(current, activeTaxonomyReferences(taxonomiesQuery.data.amenities)),
      );
    }
    setTaxonomyStatus(undefined);
    setTaxonomyErrors({});
    setter(ids);
  }

  function changeContent(update: () => void) {
    setContentStatus(undefined);
    setContentErrors({});
    update();
  }

  function resolveTaxonomyConflict(useRemote: boolean) {
    if (conflict?.kind !== "taxonomy" || conflict.remote === undefined) return;
    const remote = conflict.remote;
    const revision = studioRevisionToken(remote);
    setKnownTags((current) => mergeKnownTaxonomies(current, remote.revision.tags));
    setKnownAmenities((current) => mergeKnownTaxonomies(current, remote.revision.amenities));
    if (useRemote) {
      setTagIds(taxonomyIds(remote.revision.tags));
      setAmenityIds(taxonomyIds(remote.revision.amenities));
    }
    setTaxonomyErrors({});
    taxonomyMutation.reset();
    onTaxonomyRevisionChange(revision);
    setConflict(undefined);
  }

  function resolveContentConflict(useRemote: boolean) {
    if (conflict?.kind !== "content" || conflict.remote === undefined) return;
    const revision = studioRevisionToken(conflict.remote);
    if (useRemote) {
      setUsageRules(conflict.remote.revision.usageRules);
      setYoutubeInput(conflict.remote.revision.youtubeVideoId ?? "");
      setFaqs(editorFaqs(conflict.remote));
    }
    setContentErrors({});
    contentMutation.reset();
    onContentRevisionChange(revision);
    setConflict(undefined);
  }

  function submitTaxonomy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    taxonomyMutation.reset();
    setTaxonomyStatus(undefined);
    const parsed = studioTaxonomyPayloadSchema.safeParse({ amenityIds, tagIds });
    if (!parsed.success) {
      setTaxonomyErrors(issueErrors(parsed.error.issues));
      return;
    }
    setTaxonomyErrors({});
    pendingTaxonomy.current = {
      command: {
        action: "studio.revision.updateTaxonomy",
        expectedScope: userId,
        idempotencyKey: crypto.randomUUID(),
        payload: {
          ...parsed.data,
          expectedRevisionId: taxonomyRevision.id,
          expectedRevisionVersion: taxonomyRevision.version,
          studioId: initialEditor.studioId,
        },
      },
      expectedEditor: studioEditorSchema.parse(editorQuery.data),
    };
    onCommandStart();
    taxonomyMutation.mutate();
  }

  function submitContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    contentMutation.reset();
    setContentStatus(undefined);
    const video = studioYoutubeVideoInputSchema.safeParse(youtubeInput);
    if (!video.success) {
      setContentErrors({ youtubeVideo: video.error.issues[0]?.message ?? "Revise o vídeo." });
      return;
    }
    const parsed = studioContentPayloadSchema.safeParse({
      faqs: faqs.map(({ answer, question }) => ({ answer, question })),
      usageRules,
      youtubeVideoId: video.data,
    });
    if (!parsed.success) {
      setContentErrors(issueErrors(parsed.error.issues));
      return;
    }
    setContentErrors({});
    pendingContent.current = {
      command: {
        action: "studio.revision.updateContent",
        expectedScope: userId,
        idempotencyKey: crypto.randomUUID(),
        payload: {
          ...parsed.data,
          expectedRevisionId: contentRevision.id,
          expectedRevisionVersion: contentRevision.version,
          studioId: initialEditor.studioId,
        },
      },
      expectedEditor: studioEditorSchema.parse(editorQuery.data),
    };
    onCommandStart();
    contentMutation.mutate();
  }

  const editor = editorQuery.data;
  const taxonomies = taxonomiesQuery.data;
  const tagChoices = selectableTaxonomies(knownTags, taxonomies.tags, tagIds, editor.revision.tags);
  const amenityChoices = selectableTaxonomies(
    knownAmenities,
    taxonomies.amenities,
    amenityIds,
    editor.revision.amenities,
  );
  const activeTagIds = new Set(taxonomies.tags.map((tag) => tag.id));
  const activeAmenityIds = new Set(taxonomies.amenities.map((amenity) => amenity.id));
  const hasArchivedSelection =
    tagIds.some((id) => !activeTagIds.has(id)) ||
    amenityIds.some((id) => !activeAmenityIds.has(id));
  const canEdit =
    editor.studioStatus !== "disabled" &&
    (editor.revision.status === "draft" ||
      (!editor.hasDraft && editor.revision.status === "approved"));
  const pending = taxonomyMutation.isPending || contentMutation.isPending;
  const taxonomyError = apiError(taxonomyMutation.error);
  const contentError = apiError(contentMutation.error);
  const hasAmbiguousTaxonomy = taxonomyError !== undefined && isAmbiguousStudioError(taxonomyError);
  const hasAmbiguousContent = contentError !== undefined && isAmbiguousStudioError(contentError);
  const mutationLocked =
    pending ||
    hasAmbiguousTaxonomy ||
    hasAmbiguousContent ||
    externalCommandLocked ||
    conflict !== undefined;
  const videoId = parseStudioYoutubeVideoId(youtubeInput);

  if (!editorIsVerified) {
    const verifying = !hydrated || editorQuery.fetchStatus === "fetching";
    return (
      <Alert
        title={
          verifying
            ? "Verificando o conteúdo comercial seguro"
            : "Não foi possível verificar o conteúdo comercial"
        }
        variant={verifying ? "status" : "error"}
      >
        <Stack space={3}>
          <span>
            {verifying
              ? "O conteúdo privado permanecerá oculto até a confirmação autoritativa da sessão."
              : "O conteúdo privado continua oculto. Verifique novamente a sessão antes de editar."}
          </span>
          {verifying ? null : (
            <Button onClick={() => void editorQuery.refetch()} variant="secondary">
              Verificar conteúdo comercial novamente
            </Button>
          )}
        </Stack>
      </Alert>
    );
  }

  if (taxonomiesQuery.fetchStatus !== "idle" || taxonomiesQuery.isError) {
    const verifying = taxonomiesQuery.fetchStatus === "fetching";
    return (
      <Alert
        title={verifying ? "Atualizando as taxonomias" : "Não foi possível atualizar as taxonomias"}
        variant={verifying ? "status" : "error"}
      >
        {verifying ? (
          "Aguarde a confirmação do catálogo ativo."
        ) : (
          <Button onClick={() => void taxonomiesQuery.refetch()} variant="secondary">
            Tentar carregar novamente
          </Button>
        )}
      </Alert>
    );
  }

  return (
    <section aria-labelledby="studio-commercial-content-title" className={styles.contentPanel}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id="studio-commercial-content-title">
          Conteúdo comercial
        </h2>
        <p className={styles.sectionDescription}>
          Taxonomias, regras, perguntas e vídeo pertencem à mesma revisão privada indicada acima.
        </p>
      </div>
      <ConflictRecoveryFeedback
        conflict={conflict}
        onRetry={() => {
          if (conflict !== undefined) void recoverConflict(conflict.kind);
        }}
      />
      {conflict?.kind === "taxonomy" && conflict.remote !== undefined ? (
        <TaxonomyConflictComparison
          amenityChoices={amenityChoices}
          localAmenityIds={amenityIds}
          localTagIds={tagIds}
          onKeepLocal={() => resolveTaxonomyConflict(false)}
          onUseRemote={() => resolveTaxonomyConflict(true)}
          remote={conflict.remote}
          tagChoices={tagChoices}
        />
      ) : null}
      {conflict?.kind === "content" && conflict.remote !== undefined ? (
        <ContentConflictComparison
          faqs={faqs}
          onKeepLocal={() => resolveContentConflict(false)}
          onUseRemote={() => resolveContentConflict(true)}
          remote={conflict.remote}
          usageRules={usageRules}
          youtubeInput={youtubeInput}
        />
      ) : null}
      {taxonomies.tags.length === 0 || taxonomies.amenities.length === 0 ? (
        <Alert title="Taxonomia indisponível" variant="error">
          O catálogo ativo precisa ser corrigido no backoffice. Nenhuma opção improvisada será
          criada por esta tela.
        </Alert>
      ) : null}
      <div className={styles.contentForms}>
        <form className={styles.formCard} noValidate onSubmit={submitTaxonomy}>
          <StudioCommandFeedback
            error={taxonomyError}
            onRetry={hasAmbiguousTaxonomy ? () => taxonomyMutation.mutate() : undefined}
          />
          {taxonomyStatus === undefined ? null : (
            <Alert title="Taxonomias salvas" variant="status">
              {taxonomyStatus}
            </Alert>
          )}
          <div className={styles.taxonomyGrid}>
            <TaxonomySelector
              disabled={!canEdit || mutationLocked}
              label="Tags"
              onChange={(ids) => changeTaxonomy("tags", setTagIds, ids)}
              options={tagChoices}
              selectedIds={tagIds}
            />
            <TaxonomySelector
              disabled={!canEdit || mutationLocked}
              label="Comodidades"
              onChange={(ids) => changeTaxonomy("amenities", setAmenityIds, ids)}
              options={amenityChoices}
              selectedIds={amenityIds}
            />
          </div>
          {hasArchivedSelection ? (
            <Alert title="Remova as opções arquivadas" variant="error">
              Elas permanecem visíveis para preservar o histórico, mas não podem integrar uma nova
              gravação.
            </Alert>
          ) : null}
          {Object.keys(taxonomyErrors).length === 0 ? null : (
            <Alert title="Revise a seleção" variant="error">
              Selecione no máximo 20 opções únicas em cada grupo.
            </Alert>
          )}
          <Button
            disabled={!canEdit || mutationLocked || hasArchivedSelection}
            loading={taxonomyMutation.isPending}
            type="submit"
          >
            Salvar tags e comodidades
          </Button>
        </form>

        <form className={styles.formCard} noValidate onSubmit={submitContent}>
          <StudioCommandFeedback
            error={contentError}
            onRetry={hasAmbiguousContent ? () => contentMutation.mutate() : undefined}
          />
          {contentStatus === undefined ? null : (
            <Alert title="Conteúdo salvo" variant="status">
              {contentStatus}
            </Alert>
          )}
          <Field
            {...fieldErrorProp(contentErrors, "usageRules")}
            description={`${usageRules.length.toLocaleString("pt-BR")} de 5.000 caracteres`}
            label="Regras de uso"
          >
            <Textarea
              disabled={!canEdit || mutationLocked}
              maxLength={5000}
              onChange={(event) => changeContent(() => setUsageRules(event.currentTarget.value))}
              rows={7}
              value={usageRules}
            />
          </Field>
          <Field
            {...fieldErrorProp(contentErrors, "youtubeVideo")}
            description="Cole uma URL HTTPS permitida ou o ID de 11 caracteres. Somente o ID será salvo."
            label="Vídeo do YouTube"
          >
            <Input
              disabled={!canEdit || mutationLocked}
              inputMode="url"
              maxLength={500}
              onChange={(event) => changeContent(() => setYoutubeInput(event.currentTarget.value))}
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeInput}
            />
          </Field>
          {typeof videoId === "string" ? (
            <div className={styles.videoPreview}>
              <div className={styles.videoFrame}>
                <iframe
                  allow="encrypted-media; picture-in-picture"
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="strict-origin-when-cross-origin"
                  sandbox="allow-scripts allow-same-origin allow-presentation"
                  src={`https://www.youtube-nocookie.com/embed/${videoId}`}
                  title="Prévia do vídeo do estúdio"
                />
              </div>
              <a
                className={styles.videoFallback}
                href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                Abrir vídeo diretamente no YouTube
              </a>
            </div>
          ) : null}
          <FaqEditor
            disabled={!canEdit || mutationLocked}
            errors={contentErrors}
            faqs={faqs}
            onChange={(nextFaqs) => changeContent(() => setFaqs(nextFaqs))}
          />
          <section aria-labelledby="studio-content-preview-title" className={styles.safePreview}>
            <h3 className={styles.sectionTitle} id="studio-content-preview-title">
              Prévia segura do texto
            </h3>
            <p className={styles.previewDescription}>
              {usageRules.trim() === "" ? "As regras aparecerão aqui." : usageRules}
            </p>
            {faqs.length === 0 ? (
              <p className={styles.sectionDescription}>Nenhuma pergunta adicionada.</p>
            ) : (
              <dl className={styles.previewFaqs}>
                {faqs.map((faq) => (
                  <div key={faq.key}>
                    <dt>{faq.question || "Pergunta ainda sem texto"}</dt>
                    <dd>{faq.answer || "Resposta ainda sem texto"}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <Button
            disabled={!canEdit || mutationLocked}
            loading={contentMutation.isPending}
            type="submit"
          >
            Salvar regras, FAQ e vídeo
          </Button>
        </form>
      </div>
    </section>
  );
}
