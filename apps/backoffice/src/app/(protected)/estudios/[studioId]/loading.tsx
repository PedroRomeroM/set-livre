import styles from "@/domains/backoffice/components/backoffice.module.css";

export default function BackofficeStudioReviewLoading() {
  return (
    <section aria-busy aria-labelledby="studio-review-route-loading" className={styles.pageStack}>
      <h1 id="studio-review-route-loading">Confirmando o caso editorial</h1>
      <p role="status">Carregando o estado, as permissões e as prévias privadas atuais…</p>
    </section>
  );
}
