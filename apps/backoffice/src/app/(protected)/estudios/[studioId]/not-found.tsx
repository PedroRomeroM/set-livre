import { Alert, ButtonLink } from "@set-livre/ui";

import styles from "@/domains/backoffice/components/backoffice.module.css";

export default function BackofficeStudioReviewNotFound() {
  return (
    <section aria-labelledby="studio-review-route-not-found" className={styles.pageStack}>
      <Alert title="Revisão não encontrada" variant="error">
        <p id="studio-review-route-not-found">
          O caso não existe mais ou não está disponível para esta sessão. Nenhum detalhe privado foi
          exibido.
        </p>
      </Alert>
      <div>
        <ButtonLink href="/estudios">Voltar aos estúdios</ButtonLink>
      </div>
    </section>
  );
}
