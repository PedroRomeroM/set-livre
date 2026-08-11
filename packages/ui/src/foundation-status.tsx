import styles from "./foundation-status.module.css";

type FoundationStatusProps = {
  application: "Plataforma pública" | "Backoffice";
  description: string;
  title: string;
};

export function FoundationStatus({ application, description, title }: FoundationStatusProps) {
  return (
    <main className={styles.shell}>
      <section className={styles.panel} aria-labelledby="foundation-title">
        <p className={styles.eyebrow}>{application} · ambiente local</p>
        <h1 className={styles.title} id="foundation-title">
          {title}
        </h1>
        <p className={styles.description}>{description}</p>
        <p className={styles.status} role="status">
          <span className={styles.dot} aria-hidden="true" />
          Fundação executável e pronta para o primeiro corte vertical.
        </p>
        <p className={styles.note}>
          Esta tela comprova somente a fundação técnica. Nenhuma feature de produto é simulada.
        </p>
      </section>
    </main>
  );
}
