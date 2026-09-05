"use client";

import type {
  BackofficeSession,
  BackofficeStudioReviewQueue,
  BackofficeStudioReviewQueueItem,
} from "@set-livre/contracts";
import { Alert, Button, ButtonLink } from "@set-livre/ui";
import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";

import { BackofficeClientError, listBackofficeStudioReviewsClient } from "./backoffice-api";
import styles from "./backoffice.module.css";
import { backofficeQueryKeys } from "./query-keys";
import reviewStyles from "./studio-review.module.css";
import { useBackofficeHydrated } from "./use-backoffice-hydrated";

type AuthenticatedSession = Extract<BackofficeSession, { authenticated: true }>;

const reviewStateLabels: Record<BackofficeStudioReviewQueueItem["reviewState"], string> = {
  disabled: "Desativado",
  moderation: "Moderação administrativa",
  reviewPending: "Revisão pendente",
};

function errorMessage(error: unknown) {
  return error instanceof BackofficeClientError
    ? error.message
    : "Não foi possível carregar a fila agora.";
}

export function StudioReviewQueue({ session }: { session: AuthenticatedSession }) {
  const interactive = useBackofficeHydrated();
  const reviews = useInfiniteQuery<
    BackofficeStudioReviewQueue,
    Error,
    InfiniteData<BackofficeStudioReviewQueue>,
    ReturnType<typeof backofficeQueryKeys.studios>,
    string | null
  >({
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: null as string | null,
    networkMode: "always",
    queryFn: ({ pageParam, signal }) =>
      listBackofficeStudioReviewsClient(
        { expectedScope: session.scope, query: { cursor: pageParam } },
        signal,
      ),
    queryKey: backofficeQueryKeys.studios(session.scope),
    refetchOnReconnect: true,
    retry: false,
    retryOnMount: false,
  });
  const items = reviews.data?.pages.flatMap((page) => page.items) ?? [];
  const initialFailure = reviews.isError && items.length === 0;
  const incrementalFailure = reviews.isFetchNextPageError && items.length > 0;
  const backgroundFailure = reviews.isRefetchError && !incrementalFailure && items.length > 0;

  return (
    <section
      aria-busy={!interactive || reviews.isPending || reviews.isFetchingNextPage}
      aria-labelledby="studio-review-title"
      className={styles.pageStack}
      inert={!interactive}
    >
      <header>
        <p className={styles.eyebrow}>Curadoria e segurança</p>
        <h1 id="studio-review-title">Estúdios</h1>
        <p>
          Revise candidatas submetidas. Administradores também encontram publicações moderáveis e
          estúdios desativados, sem misturar esses estados com a fila editorial.
        </p>
      </header>
      {reviews.isPending ? <p role="status">Carregando estúdios…</p> : null}
      {initialFailure ? (
        <Alert title="A fila não pôde ser carregada" variant="error">
          <p>{errorMessage(reviews.error)}</p>
          <div className={reviewStyles.actions}>
            <Button
              disabled={!interactive || reviews.isFetching}
              loading={reviews.isFetching}
              loadingLabel="Tentando novamente"
              onClick={() => void reviews.refetch()}
              variant="secondary"
            >
              Tentar carregar novamente
            </Button>
          </div>
        </Alert>
      ) : null}
      {incrementalFailure ? (
        <Alert title="A próxima página não pôde ser carregada" variant="error">
          <p>{errorMessage(reviews.error)}</p>
          <p>Os estúdios já confirmados permanecem disponíveis abaixo.</p>
          <div className={reviewStyles.actions}>
            <Button
              disabled={!interactive || reviews.isFetchingNextPage}
              loading={reviews.isFetchingNextPage}
              loadingLabel="Tentando novamente"
              onClick={() => void reviews.fetchNextPage()}
              variant="secondary"
            >
              Tentar próxima página novamente
            </Button>
          </div>
        </Alert>
      ) : null}
      {backgroundFailure ? (
        <Alert title="A atualização da fila falhou" variant="error">
          <p>{errorMessage(reviews.error)}</p>
          <p>
            Os estúdios já confirmados continuam visíveis, mas podem estar desatualizados até a nova
            leitura concluir.
          </p>
          <div className={reviewStyles.actions}>
            <Button
              disabled={!interactive || reviews.isFetching}
              loading={reviews.isFetching}
              loadingLabel="Atualizando novamente"
              onClick={() => void reviews.refetch()}
              variant="secondary"
            >
              Tentar atualizar a fila novamente
            </Button>
          </div>
        </Alert>
      ) : null}
      {!reviews.isPending && !initialFailure && items.length === 0 ? (
        <p className={reviewStyles.empty}>Nenhum estúdio exige ação agora.</p>
      ) : null}
      <div className={reviewStyles.queueGrid}>
        {items.map((item) => (
          <article className={reviewStyles.queueCard} key={`${item.reviewState}:${item.studioId}`}>
            <div className={reviewStyles.queueHeader}>
              <div>
                <h2>{item.name}</h2>
                <p className={reviewStyles.metadata}>Estúdio …{item.studioId.slice(-8)}</p>
              </div>
              <span className={reviewStyles.badge} data-state={item.reviewState}>
                {reviewStateLabels[item.reviewState]}
              </span>
            </div>
            <p className={reviewStyles.metadata}>
              Versão editorial {item.publicationVersion}
              {item.submittedAt === null
                ? ""
                : ` · enviada em ${new Date(item.submittedAt).toLocaleString("pt-BR", {
                    timeZone: "America/Sao_Paulo",
                  })}`}
            </p>
            <p className={reviewStyles.muted}>
              {item.hasPublished
                ? "Existe uma versão pública preservada."
                : "Primeira publicação; ainda não há versão pública."}
            </p>
            <ButtonLink href={`/estudios/${item.studioId}`} variant="secondary">
              {item.reviewState === "reviewPending" ? "Abrir revisão" : "Abrir moderação"}
            </ButtonLink>
          </article>
        ))}
      </div>
      {reviews.hasNextPage && !incrementalFailure ? (
        <div className={styles.pagination}>
          <Button
            disabled={!interactive || reviews.isFetchingNextPage}
            loading={reviews.isFetchingNextPage}
            loadingLabel="Carregando"
            onClick={() => reviews.fetchNextPage()}
            variant="secondary"
          >
            Carregar mais
          </Button>
        </div>
      ) : null}
    </section>
  );
}
