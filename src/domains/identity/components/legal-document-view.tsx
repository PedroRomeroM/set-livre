import type { CurrentLegalDocuments } from "@set-livre/contracts";
import { Alert, PageFrame, Panel, Stack } from "@set-livre/ui";
import Link from "next/link";

import styles from "./identity.module.css";

type LegalDocument = CurrentLegalDocuments["privacy"] | CurrentLegalDocuments["terms"];

type LegalDocumentViewProps = {
  document: LegalDocument;
};

function displayDate(isoDate: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "long",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(isoDate));
}

function bodyParagraphs(bodyMarkdown: string, title: string) {
  const paragraphs = bodyMarkdown
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.replace(/^#{1,6}\s+/u, ""));
  return paragraphs[0]?.toLocaleLowerCase("pt-BR") === title.toLocaleLowerCase("pt-BR")
    ? paragraphs.slice(1)
    : paragraphs;
}

export function LegalDocumentView({ document }: LegalDocumentViewProps) {
  return (
    <PageFrame width="narrow">
      <Panel>
        <Stack space={5}>
          <header className={styles.legalHeader}>
            <Link className={styles.backLink} href="/cadastro">
              Voltar ao cadastro
            </Link>
            <h1 className={styles.legalTitle}>{document.title}</h1>
            <p className={styles.legalMeta}>
              Versão {document.version} · vigente desde {displayDate(document.effectiveAt)}
            </p>
          </header>

          {document.source === "local_fixture" ? (
            <Alert title="Conteúdo exclusivo do ambiente local" variant="error">
              Este texto é uma fixture para desenvolvimento e testes. Não é um documento jurídico
              aprovado e não pode ser publicado em produção.
            </Alert>
          ) : null}

          <div className={styles.legalBody}>
            {bodyParagraphs(document.bodyMarkdown, document.title).map((paragraph, index) => (
              <p className={styles.legalParagraph} key={`${index}-${paragraph.slice(0, 24)}`}>
                {paragraph}
              </p>
            ))}
          </div>

          <div className={styles.actions}>
            <Link className={styles.textLink} href="/cadastro">
              Voltar e continuar o cadastro
            </Link>
            <Link className={styles.textLink} href="/entrar">
              Ir para o login
            </Link>
          </div>
        </Stack>
      </Panel>
    </PageFrame>
  );
}
