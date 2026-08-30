"use client";

import {
  type BackofficeSession,
  type BackofficeTaxonomyItem,
  type BackofficeTaxonomyKind,
  type BackofficeTaxonomySetActiveCommand,
  type BackofficeTaxonomyUpsertCommand,
} from "@set-livre/contracts";
import { Alert, Button, Field, Input, Select } from "@set-livre/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  BackofficeClientError,
  executeBackofficeTaxonomyCommand,
  isAmbiguousBackofficeError,
  listBackofficeTaxonomiesClient,
} from "./backoffice-api";
import { backofficeQueryKeys } from "./query-keys";
import styles from "./backoffice.module.css";

type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;

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

function TaxonomyForm({
  editing,
  generation,
  onCancel,
  onRetry,
  onSubmit,
  pending,
  retrying,
}: {
  editing?: BackofficeTaxonomyItem | undefined;
  generation: number;
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
  const locked = pending || retrying;
  return (
    <form
      className={styles.taxonomyForm}
      key={`${editing?.id ?? "new"}:${generation}`}
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
      <Field label="Grupo" required>
        <Select
          defaultValue={editing?.kind ?? "studioType"}
          disabled={editing !== undefined || locked}
          name="kind"
        >
          {Object.entries(kindLabels).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ordem" required>
        <Input
          defaultValue={editing?.sortOrder ?? 0}
          disabled={locked}
          max={32767}
          min={0}
          name="sortOrder"
          type="number"
        />
      </Field>
      <Field label="Nome" required>
        <Input
          defaultValue={editing?.name}
          disabled={locked}
          maxLength={80}
          minLength={2}
          name="name"
        />
      </Field>
      <Field
        description="Letras minúsculas, números e hífens; precisa ser único no grupo."
        label="Slug"
        required
      >
        <Input
          defaultValue={editing?.slug}
          disabled={locked}
          maxLength={80}
          minLength={2}
          name="slug"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        />
      </Field>
      <div className={styles.actions}>
        <Button loading={pending} loadingLabel="Salvando" type="submit">
          {retrying
            ? "Repetir mesma tentativa"
            : editing === undefined
              ? "Criar taxonomia"
              : "Salvar edição"}
        </Button>
        {editing === undefined ? null : (
          <Button disabled={locked} onClick={onCancel} variant="ghost">
            Cancelar edição
          </Button>
        )}
      </div>
    </form>
  );
}

export function TaxonomyManager({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<BackofficeTaxonomyItem>();
  const [formGeneration, setFormGeneration] = useState(0);
  const [activationTarget, setActivationTarget] = useState<BackofficeTaxonomyItem>();
  const [activationRetryAvailable, setActivationRetryAvailable] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [upsertRetryAvailable, setUpsertRetryAvailable] = useState(false);
  const pendingActivationCommand = useRef<BackofficeTaxonomySetActiveCommand>(undefined);
  const pendingUpsertCommand = useRef<BackofficeTaxonomyUpsertCommand>(undefined);
  const taxonomies = useQuery({
    queryFn: listBackofficeTaxonomiesClient,
    queryKey: backofficeQueryKeys.taxonomies(session.scope),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: backofficeQueryKeys.taxonomies(session.scope) });
  const upsert = useMutation({
    mutationFn: () => {
      if (pendingUpsertCommand.current === undefined) {
        throw new Error("A taxonomia não possui solicitação idempotente preparada.");
      }
      return executeBackofficeTaxonomyCommand(pendingUpsertCommand.current);
    },
    networkMode: "always",
    onError: (error) => {
      const ambiguous = isAmbiguousBackofficeError(error);
      setUpsertRetryAvailable(ambiguous);
      if (!ambiguous) pendingUpsertCommand.current = undefined;
    },
    onSuccess: async (item) => {
      pendingUpsertCommand.current = undefined;
      setUpsertRetryAvailable(false);
      setEditing(undefined);
      setFormGeneration((current) => current + 1);
      setNotice(`Taxonomia “${item.name}” salva na versão ${item.version}.`);
      await invalidate();
    },
  });
  const setActive = useMutation({
    mutationFn: () => {
      if (pendingActivationCommand.current === undefined) {
        throw new Error("O arquivamento não possui solicitação idempotente preparada.");
      }
      return executeBackofficeTaxonomyCommand(pendingActivationCommand.current);
    },
    networkMode: "always",
    onError: (error) => {
      const ambiguous = isAmbiguousBackofficeError(error);
      setActivationRetryAvailable(ambiguous);
      if (!ambiguous) pendingActivationCommand.current = undefined;
    },
    onSuccess: async (item) => {
      pendingActivationCommand.current = undefined;
      setActivationRetryAvailable(false);
      setActivationTarget(undefined);
      setNotice(
        item.active
          ? `“${item.name}” reativada para novas seleções.`
          : `“${item.name}” arquivada; referências históricas preservadas.`,
      );
      await invalidate();
    },
  });
  const items = taxonomies.data?.items ?? [];

  return (
    <section aria-labelledby="taxonomies-title" className={styles.pageStack}>
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
          editing={editing}
          generation={formGeneration}
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
      {taxonomies.isError ? <Alert variant="error">{taxonomyError(taxonomies.error)}</Alert> : null}
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
                      onClick={() => {
                        pendingActivationCommand.current = undefined;
                        setActivationRetryAvailable(false);
                        setActive.reset();
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
            Impacto da {activationTarget.active ? "desativação" : "reativação"}
          </h2>
          <p>
            <strong>{activationTarget.name}</strong> possui {activationTarget.usageCount}{" "}
            referências.{" "}
            {activationTarget.active
              ? "Ela deixará de aceitar novas seleções, mas todas as referências existentes continuarão legíveis."
              : "Ela voltará a aparecer em novas seleções; o histórico não será alterado."}
          </p>
          {setActive.isError ? (
            <Alert variant="error">{taxonomyError(setActive.error)}</Alert>
          ) : null}
          <div className={styles.actions}>
            <Button
              loading={setActive.isPending}
              loadingLabel="Aplicando"
              onClick={() => {
                pendingActivationCommand.current ??= {
                  action: "backoffice.taxonomy.setActive",
                  expectedScope: session.scope,
                  idempotencyKey: crypto.randomUUID(),
                  payload: {
                    active: !activationTarget.active,
                    expectedVersion: activationTarget.version,
                    id: activationTarget.id,
                    kind: activationTarget.kind,
                  },
                };
                setActive.mutate();
              }}
            >
              {!activationRetryAvailable
                ? `Confirmar ${activationTarget.active ? "arquivamento" : "reativação"}`
                : "Repetir mesma tentativa"}
            </Button>
            <Button
              disabled={activationRetryAvailable}
              onClick={() => {
                pendingActivationCommand.current = undefined;
                setActivationRetryAvailable(false);
                setActive.reset();
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
