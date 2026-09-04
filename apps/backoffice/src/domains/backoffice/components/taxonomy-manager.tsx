"use client";

import {
  type BackofficeSession,
  type BackofficeTaxonomyItem,
  type BackofficeTaxonomyKind,
  type BackofficeTaxonomyList,
  type BackofficeTaxonomyStatusCommand,
  type BackofficeTaxonomyUpsertCommand,
} from "@set-livre/contracts";
import { Alert, Button, Field, Input, Select } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  BackofficeClientError,
  executeBackofficeTaxonomyCommand,
  isAmbiguousBackofficeError,
  isStaleBackofficeError,
  listBackofficeTaxonomiesClient,
} from "./backoffice-api";
import { backofficeQueryKeys } from "./query-keys";
import { useBackofficeHydrated } from "./use-backoffice-hydrated";
import styles from "./backoffice.module.css";

type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;
type TaxonomyFieldName = "kind" | "name" | "slug" | "sortOrder";
type TaxonomyFieldErrors = Partial<Record<TaxonomyFieldName, string>>;

const taxonomyFieldNames = ["kind", "name", "slug", "sortOrder"] as const;

const kindLabels: Record<BackofficeTaxonomyKind, string> = {
  amenity: "Comodidades",
  studioType: "Tipos de estúdio",
  tag: "Tags",
};

function taxonomyError(error: unknown) {
  if (isAmbiguousBackofficeError(error)) {
    return "O resultado não pôde ser confirmado. Repita a mesma tentativa idempotente antes de editar os campos.";
  }
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível concluir agora. Tente novamente.";
}

function taxonomyListError(error: unknown) {
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível carregar as taxonomias agora. Tente novamente.";
}

export function taxonomyFieldErrors(error: unknown): TaxonomyFieldErrors | undefined {
  if (!(error instanceof BackofficeClientError) || error.fieldErrors === undefined) {
    return undefined;
  }
  const retainedErrors: TaxonomyFieldErrors = {};
  for (const field of taxonomyFieldNames) {
    const message = error.fieldErrors[field];
    if (message !== undefined) retainedErrors[field] = message;
  }
  return Object.keys(retainedErrors).length === 0 ? undefined : retainedErrors;
}

export function taxonomyStatusNoticeFromRetainedState(
  commandResult: BackofficeTaxonomyItem,
  retainedItem: BackofficeTaxonomyItem | undefined,
) {
  if (
    retainedItem === undefined ||
    retainedItem.id !== commandResult.id ||
    retainedItem.kind !== commandResult.kind ||
    retainedItem.version < commandResult.version ||
    (retainedItem.version === commandResult.version && retainedItem.active !== commandResult.active)
  ) {
    return undefined;
  }
  if (retainedItem.version > commandResult.version) {
    return retainedItem.active
      ? `O estado mais recente de “${retainedItem.name}” foi preservado: ativa para novas seleções.`
      : `O estado mais recente de “${retainedItem.name}” foi preservado: arquivada, com referências históricas preservadas.`;
  }
  return retainedItem.active
    ? `“${retainedItem.name}” reativada para novas seleções.`
    : `“${retainedItem.name}” arquivada; referências históricas preservadas.`;
}

export function taxonomyUpsertNoticeFromRetainedState(
  commandResult: BackofficeTaxonomyItem,
  retainedItem: BackofficeTaxonomyItem | undefined,
) {
  if (
    retainedItem === undefined ||
    retainedItem.id !== commandResult.id ||
    retainedItem.kind !== commandResult.kind ||
    retainedItem.version < commandResult.version
  ) {
    return undefined;
  }
  return retainedItem.version === commandResult.version
    ? `Taxonomia “${retainedItem.name}” salva na versão ${retainedItem.version}.`
    : `O estado mais recente de “${retainedItem.name}” foi preservado na versão ${retainedItem.version}.`;
}

export function TaxonomyForm({
  blocked,
  editing,
  fieldErrors,
  generation,
  interactive,
  onCancel,
  onRetry,
  onSubmit,
  pending,
  retrying,
}: {
  blocked: boolean;
  editing?: BackofficeTaxonomyItem | undefined;
  fieldErrors: TaxonomyFieldErrors | undefined;
  generation: number;
  interactive: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onSubmit: (value: {
    kind: BackofficeTaxonomyKind;
    name: string;
    slug: string;
    sortOrder: number;
  }) => void;
  pending: boolean;
  retrying: boolean;
}) {
  const fieldsLocked = !interactive || blocked || pending || retrying;
  const submitLocked = !interactive || blocked;
  return (
    <form
      aria-busy={!interactive || pending}
      className={styles.taxonomyForm}
      inert={!interactive}
      key={`${editing?.id ?? "new"}:${generation}`}
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (retrying) {
          onRetry();
          return;
        }
        const data = new FormData(event.currentTarget);
        onSubmit({
          kind: editing?.kind ?? (String(data.get("kind")) as BackofficeTaxonomyKind),
          name: String(data.get("name") ?? ""),
          slug: String(data.get("slug") ?? ""),
          sortOrder: Number(data.get("sortOrder")),
        });
      }}
    >
      <fieldset
        className={`${styles.secureFormBoundary} ${styles.taxonomyFormBoundary}`}
        disabled={!interactive}
      >
        <Field
          {...(fieldErrors?.kind === undefined ? {} : { error: fieldErrors.kind })}
          label="Grupo"
          required
        >
          <Select
            defaultValue={editing?.kind ?? "studioType"}
            disabled={editing !== undefined || fieldsLocked}
            name="kind"
          >
            {Object.entries(kindLabels).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          {...(fieldErrors?.sortOrder === undefined ? {} : { error: fieldErrors.sortOrder })}
          label="Ordem"
          required
        >
          <Input
            defaultValue={editing?.sortOrder ?? 0}
            disabled={fieldsLocked}
            max={32767}
            min={0}
            name="sortOrder"
            type="number"
          />
        </Field>
        <Field
          {...(fieldErrors?.name === undefined ? {} : { error: fieldErrors.name })}
          label="Nome"
          required
        >
          <Input
            defaultValue={editing?.name}
            disabled={fieldsLocked}
            maxLength={80}
            minLength={2}
            name="name"
          />
        </Field>
        <Field
          description="Letras minúsculas, números e hífens; precisa ser único no grupo."
          {...(fieldErrors?.slug === undefined ? {} : { error: fieldErrors.slug })}
          label="Slug"
          required
        >
          <Input
            defaultValue={editing?.slug}
            disabled={fieldsLocked}
            maxLength={80}
            minLength={2}
            name="slug"
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          />
        </Field>
        <div className={styles.actions}>
          <Button disabled={submitLocked} loading={pending} loadingLabel="Salvando" type="submit">
            {retrying
              ? "Repetir mesma tentativa"
              : editing === undefined
                ? "Criar taxonomia"
                : "Salvar edição"}
          </Button>
          {editing === undefined ? null : (
            <Button disabled={fieldsLocked} onClick={onCancel} variant="ghost">
              Cancelar edição
            </Button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

export function TaxonomyManager({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const interactive = useBackofficeHydrated();
  const [editing, setEditing] = useState<BackofficeTaxonomyItem>();
  const [formGeneration, setFormGeneration] = useState(0);
  const [activationTarget, setActivationTarget] = useState<BackofficeTaxonomyItem>();
  const [activationRetryAvailable, setActivationRetryAvailable] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [upsertRetryAvailable, setUpsertRetryAvailable] = useState(false);
  const pendingActivationCommand = useRef<BackofficeTaxonomyStatusCommand>(undefined);
  const pendingUpsertCommand = useRef<BackofficeTaxonomyUpsertCommand>(undefined);
  const taxonomyQueryKey = backofficeQueryKeys.taxonomies(session.scope);
  const taxonomies = useQuery({
    queryFn: ({ signal }) => listBackofficeTaxonomiesClient(session.scope, signal),
    queryKey: taxonomyQueryKey,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: taxonomyQueryKey });
  const resetTaxonomies = () => queryClient.resetQueries({ queryKey: taxonomyQueryKey });
  const retainedTaxonomy = (id: string) =>
    queryClient
      .getQueryData<BackofficeTaxonomyList>(taxonomyQueryKey)
      ?.items.find((item) => item.id === id);
  const upsert = useMutation({
    mutationFn: () => {
      if (pendingUpsertCommand.current === undefined) {
        throw new Error("A taxonomia não possui solicitação idempotente preparada.");
      }
      return executeBackofficeTaxonomyCommand(pendingUpsertCommand.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isStaleBackofficeError(error)) {
        pendingUpsertCommand.current = undefined;
        setUpsertRetryAvailable(false);
        setEditing(undefined);
        setFormGeneration((current) => current + 1);
        setNotice("A taxonomia mudou. O catálogo foi recarregado; revise o item antes de editar.");
        await resetTaxonomies();
        return;
      }
      const ambiguous = isAmbiguousBackofficeError(error);
      setUpsertRetryAvailable(ambiguous);
      if (!ambiguous) pendingUpsertCommand.current = undefined;
    },
    onSuccess: async (item) => {
      pendingUpsertCommand.current = undefined;
      setUpsertRetryAvailable(false);
      setEditing(undefined);
      setFormGeneration((current) => current + 1);
      setNotice(undefined);
      await invalidate();
      setNotice(taxonomyUpsertNoticeFromRetainedState(item, retainedTaxonomy(item.id)));
    },
  });
  const transition = useMutation({
    mutationFn: () => {
      if (pendingActivationCommand.current === undefined) {
        throw new Error("O arquivamento não possui solicitação idempotente preparada.");
      }
      return executeBackofficeTaxonomyCommand(pendingActivationCommand.current);
    },
    networkMode: "always",
    onError: async (error) => {
      if (isStaleBackofficeError(error)) {
        pendingActivationCommand.current = undefined;
        setActivationRetryAvailable(false);
        setActivationTarget(undefined);
        setNotice("A taxonomia mudou. O catálogo foi recarregado; revise o impacto antes de agir.");
        await resetTaxonomies();
        return;
      }
      const ambiguous = isAmbiguousBackofficeError(error);
      setActivationRetryAvailable(ambiguous);
      if (!ambiguous) pendingActivationCommand.current = undefined;
    },
    onSuccess: async (item) => {
      pendingActivationCommand.current = undefined;
      setActivationRetryAvailable(false);
      setActivationTarget(undefined);
      setNotice(undefined);
      await invalidate();
      setNotice(taxonomyStatusNoticeFromRetainedState(item, retainedTaxonomy(item.id)));
    },
  });
  const items = taxonomies.data?.items ?? [];

  return (
    <section
      aria-busy={!interactive}
      aria-labelledby="taxonomies-title"
      className={styles.pageStack}
      inert={!interactive}
    >
      <header>
        <p className={styles.eyebrow}>Filtros públicos</p>
        <h1 id="taxonomies-title">Taxonomias</h1>
        <p>
          Gerencie tipos, tags e comodidades. Arquivamento impede novas seleções sem reescrever o
          histórico.
        </p>
      </header>
      {notice === undefined ? null : <Alert>{notice}</Alert>}
      <section aria-labelledby="taxonomy-form-title" className={styles.card}>
        <h2 id="taxonomy-form-title">
          {editing === undefined ? "Nova taxonomia" : `Editar ${editing.name}`}
        </h2>
        {upsert.isError ? <Alert variant="error">{taxonomyError(upsert.error)}</Alert> : null}
        <TaxonomyForm
          blocked={transition.isPending || activationRetryAvailable}
          editing={editing}
          fieldErrors={taxonomyFieldErrors(upsert.error)}
          generation={formGeneration}
          interactive={interactive}
          onCancel={() => {
            pendingUpsertCommand.current = undefined;
            setUpsertRetryAvailable(false);
            upsert.reset();
            setEditing(undefined);
          }}
          onRetry={() => upsert.mutate()}
          onSubmit={(value) => {
            setNotice(undefined);
            setUpsertRetryAvailable(false);
            pendingUpsertCommand.current = {
              action: "backoffice.taxonomy.upsert",
              expectedScope: session.scope,
              idempotencyKey: crypto.randomUUID(),
              payload: {
                ...(editing === undefined
                  ? {}
                  : { expectedVersion: editing.version, id: editing.id }),
                ...value,
              },
            };
            upsert.mutate();
          }}
          pending={upsert.isPending}
          retrying={upsertRetryAvailable}
        />
      </section>
      {taxonomies.isPending ? <p role="status">Carregando taxonomias…</p> : null}
      {taxonomies.isError ? (
        <Alert title="O catálogo não pôde ser carregado" variant="error">
          <p>{taxonomyListError(taxonomies.error)}</p>
          <div className={styles.actions}>
            <Button
              disabled={!interactive || taxonomies.isFetching}
              loading={taxonomies.isFetching}
              loadingLabel="Tentando novamente"
              onClick={() => void taxonomies.refetch()}
              variant="secondary"
            >
              Tentar carregar taxonomias novamente
            </Button>
          </div>
        </Alert>
      ) : null}
      {!taxonomies.isPending && !taxonomies.isError && items.length === 0 ? (
        <p className={styles.empty}>Nenhuma taxonomia cadastrada.</p>
      ) : null}
      {(["studioType", "tag", "amenity"] as const).map((kind) => {
        const group = items.filter((item) => item.kind === kind);
        return (
          <section
            aria-labelledby={`taxonomy-${kind}`}
            className={styles.taxonomySection}
            key={kind}
          >
            <h2 id={`taxonomy-${kind}`}>{kindLabels[kind]}</h2>
            <div className={styles.taxonomyGrid}>
              {group.map((item) => (
                <article className={styles.card} key={item.id}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h3>{item.name}</h3>
                      <p className={styles.muted}>{item.slug}</p>
                    </div>
                    <span className={styles.badge} data-state={item.active ? "active" : "inactive"}>
                      {item.active ? "Ativa" : "Arquivada"}
                    </span>
                  </div>
                  <p className={styles.metadata}>
                    Ordem {item.sortOrder} · versão {item.version} · {item.usageCount}{" "}
                    {item.usageCount === 1 ? "uso" : "usos"}
                  </p>
                  <div className={styles.actions}>
                    <Button
                      disabled={
                        !interactive ||
                        activationRetryAvailable ||
                        transition.isPending ||
                        upsert.isPending ||
                        upsertRetryAvailable
                      }
                      onClick={() => {
                        pendingUpsertCommand.current = undefined;
                        setUpsertRetryAvailable(false);
                        upsert.reset();
                        setNotice(undefined);
                        setEditing(item);
                      }}
                      variant="secondary"
                    >
                      Editar
                    </Button>
                    <Button
                      disabled={
                        !interactive ||
                        activationRetryAvailable ||
                        transition.isPending ||
                        upsert.isPending ||
                        upsertRetryAvailable
                      }
                      onClick={() => {
                        pendingActivationCommand.current = undefined;
                        setActivationRetryAvailable(false);
                        transition.reset();
                        setNotice(undefined);
                        setActivationTarget(item);
                      }}
                      variant="ghost"
                    >
                      {item.active ? "Revisar arquivamento" : "Revisar reativação"}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
      {activationTarget === undefined ? null : (
        <section aria-labelledby="taxonomy-impact-title" className={styles.confirmation}>
          <h2 id="taxonomy-impact-title">
            Impacto do {activationTarget.active ? "arquivamento" : "retorno às novas seleções"}
          </h2>
          <p>
            <strong>{activationTarget.name}</strong> possui {activationTarget.usageCount}{" "}
            referências.{" "}
            {activationTarget.active
              ? "Ela deixará de aceitar novas seleções, mas todas as referências existentes continuarão legíveis."
              : "Ela voltará a aparecer em novas seleções; o histórico não será alterado."}
          </p>
          {transition.isError ? (
            <Alert variant="error">{taxonomyError(transition.error)}</Alert>
          ) : null}
          <div className={styles.actions}>
            <Button
              disabled={!interactive || upsert.isPending || upsertRetryAvailable}
              loading={transition.isPending}
              loadingLabel="Aplicando"
              onClick={() => {
                pendingActivationCommand.current ??= {
                  action: activationTarget.active
                    ? "backoffice.taxonomy.archive"
                    : "backoffice.taxonomy.reactivate",
                  expectedScope: session.scope,
                  idempotencyKey: crypto.randomUUID(),
                  payload: {
                    expectedVersion: activationTarget.version,
                    id: activationTarget.id,
                    kind: activationTarget.kind,
                  },
                };
                transition.mutate();
              }}
            >
              {!activationRetryAvailable
                ? `Confirmar ${activationTarget.active ? "arquivamento" : "reativação"}`
                : "Repetir mesma tentativa"}
            </Button>
            <Button
              disabled={!interactive || transition.isPending || activationRetryAvailable}
              onClick={() => {
                pendingActivationCommand.current = undefined;
                setActivationRetryAvailable(false);
                transition.reset();
                setActivationTarget(undefined);
              }}
              variant="ghost"
            >
              Cancelar
            </Button>
          </div>
        </section>
      )}
    </section>
  );
}
