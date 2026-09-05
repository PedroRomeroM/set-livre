import { Alert, ButtonLink } from "@set-livre/ui";

import styles from "@/domains/backoffice/components/backoffice.module.css";

export default function BackofficeAccessNotFound() {
  return (
    <section aria-labelledby="access-route-not-found" className={styles.pageStack}>
      <Alert title="Conta não encontrada" variant="error">
        <p id="access-route-not-found">
          A conta não existe mais ou não está disponível para esta sessão. Nenhum acesso privado foi
          exibido.
        </p>
      </Alert>
      <div>
        <ButtonLink href="/acessos">Voltar à busca de acessos</ButtonLink>
      </div>
    </section>
  );
}
