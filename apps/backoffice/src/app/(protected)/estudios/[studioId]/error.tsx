"use client";

import { Alert, Button, ButtonLink } from "@set-livre/ui";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import styles from "@/domains/backoffice/components/backoffice.module.css";
import reviewStyles from "@/domains/backoffice/components/studio-review.module.css";
import { useBackofficeHydrated } from "@/domains/backoffice/components/use-backoffice-hydrated";

export default function BackofficeStudioReviewError({ reset }: { reset: () => void }) {
  const interactive = useBackofficeHydrated();
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  return (
    <section
      aria-labelledby="studio-review-route-error"
      className={styles.pageStack}
      inert={!interactive}
    >
      <Alert title="Não foi possível carregar esta revisão" variant="error">
        <p id="studio-review-route-error">
          O caso permanece fechado. Tente uma nova leitura antes de tomar qualquer decisão.
        </p>
        <div className={reviewStyles.actions}>
          <Button
            disabled={!interactive || retrying}
            loading={retrying}
            loadingLabel="Carregando novamente"
            onClick={() =>
              startRetry(() => {
                reset();
                router.refresh();
              })
            }
            variant="secondary"
          >
            Tentar carregar novamente
          </Button>
        </div>
      </Alert>
      <div>
        <ButtonLink href="/estudios" variant="ghost">
          Voltar aos estúdios
        </ButtonLink>
      </div>
    </section>
  );
}
