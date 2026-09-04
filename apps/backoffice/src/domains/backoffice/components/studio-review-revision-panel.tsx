import Image from "next/image";
import { Fragment } from "react";

import reviewStyles from "./studio-review.module.css";
import {
  mediaKey,
  revisionStatusLabels,
  type MediaLoadState,
  type ReviewRevision,
} from "./studio-review-state";

export function StudioReviewRevisionPanel({
  label,
  loadMedia,
  onMediaStateChange,
  previewExpiresAt,
  revision,
}: {
  label: string;
  loadMedia: boolean;
  onMediaStateChange: (key: string, state: MediaLoadState) => void;
  previewExpiresAt: string | null;
  revision: ReviewRevision;
}) {
  return (
    <article aria-label={label} className={reviewStyles.revisionPanel}>
      <div className={reviewStyles.sectionHeader}>
        <h2>{label}</h2>
        <span className={reviewStyles.badge}>{revisionStatusLabels[revision.status]}</span>
      </div>
      <dl className={reviewStyles.definitionList}>
        <dt>Nome</dt>
        <dd>{revision.name}</dd>
        <dt>Tipo</dt>
        <dd>{revision.studioType.name}</dd>
        <dt>Capacidade</dt>
        <dd>{revision.capacity} pessoas</dd>
        <dt>Endereço</dt>
        <dd>
          {revision.street}, {revision.streetNumber}
          {revision.addressComplement === null ? "" : ` · ${revision.addressComplement}`} ·{" "}
          {revision.neighborhood}, {revision.city}/{revision.state} · CEP {revision.postalCode}
        </dd>
        <dt>Revisão</dt>
        <dd>
          #{revision.number} · versão da revisão {revision.version}
        </dd>
      </dl>
      <section className={reviewStyles.section}>
        <h3>Descrição</h3>
        <p>{revision.description}</p>
      </section>
      <section className={reviewStyles.section}>
        <h3>Regras de uso</h3>
        <p>
          {revision.usageRules === "" ? "Nenhuma regra adicional informada." : revision.usageRules}
        </p>
        {revision.youtubeVideoId === null ? null : (
          <div className={reviewStyles.videoPreview}>
            <div className={reviewStyles.videoFrame}>
              <iframe
                allow="encrypted-media; picture-in-picture"
                allowFullScreen
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(revision.youtubeVideoId)}`}
                title={`Vídeo do estúdio em ${label.toLocaleLowerCase("pt-BR")}`}
              />
            </div>
            <a
              className={reviewStyles.videoFallback}
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(revision.youtubeVideoId)}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              Abrir este vídeo diretamente no YouTube
            </a>
          </div>
        )}
      </section>
      <section className={reviewStyles.section}>
        <h3>Tags</h3>
        {revision.tags.length === 0 ? (
          <p className={reviewStyles.muted}>Nenhuma tag.</p>
        ) : (
          <ul className={reviewStyles.plainList}>
            {revision.tags.map((tag) => (
              <li key={tag.id}>{tag.name}</li>
            ))}
          </ul>
        )}
        <h3>Comodidades</h3>
        {revision.amenities.length === 0 ? (
          <p className={reviewStyles.muted}>Nenhuma comodidade.</p>
        ) : (
          <ul className={reviewStyles.plainList}>
            {revision.amenities.map((amenity) => (
              <li key={amenity.id}>{amenity.name}</li>
            ))}
          </ul>
        )}
      </section>
      <section className={reviewStyles.section}>
        <h3>Perguntas frequentes</h3>
        {revision.faqs.length === 0 ? (
          <p className={reviewStyles.muted}>Nenhuma pergunta cadastrada.</p>
        ) : (
          <dl className={reviewStyles.definitionList}>
            {revision.faqs.map((faq) => (
              <Fragment key={faq.id}>
                <dt>{faq.question}</dt>
                <dd>{faq.answer}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </section>
      <section className={reviewStyles.section}>
        <h3>Mídia</h3>
        {revision.media.length === 0 ? (
          <p className={reviewStyles.muted}>Nenhuma imagem disponível.</p>
        ) : (
          <div className={reviewStyles.mediaGrid}>
            {revision.media.map((media) => {
              const key = mediaKey(revision.id, media.id, media.previewUrl);
              return (
                <figure className={reviewStyles.mediaFigure} key={key}>
                  <div className={reviewStyles.mediaViewport}>
                    {loadMedia ? (
                      <Image
                        alt={`${revision.name}: foto ${media.position}${media.isCover ? ", capa" : ""}`}
                        height={media.height}
                        key={`${key}:${previewExpiresAt ?? "sem-expiracao"}`}
                        loading="eager"
                        onError={() => onMediaStateChange(key, "error")}
                        onLoad={(event) =>
                          onMediaStateChange(
                            key,
                            event.currentTarget.complete && event.currentTarget.naturalWidth > 0
                              ? "loaded"
                              : "error",
                          )
                        }
                        src={media.previewUrl}
                        unoptimized
                        width={media.width}
                      />
                    ) : (
                      <svg
                        aria-hidden="true"
                        className={reviewStyles.mediaPlaceholder}
                        height={media.height}
                        viewBox={`0 0 ${media.width} ${media.height}`}
                        width={media.width}
                      />
                    )}
                  </div>
                  <figcaption>
                    Foto {media.position}
                    {media.isCover ? " · capa" : ""} · {media.width} × {media.height}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </section>
    </article>
  );
}
