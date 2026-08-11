"use client";

import { Alert, Button, PageFrame, Panel, Stack } from "@set-livre/ui";

import styles from "./identity.module.css";

export function IdentityRouteLoading({ label }: { label: string }) {
  return (
    <PageFrame aria-busy="true" aria-label={label} width="narrow">
      <div className={styles.loadingPanel}>
        <Panel>
          <Alert>{label}</Alert>
        </Panel>
      </div>
    </PageFrame>
  );
}

export function IdentityRouteError({ reset }: { reset: () => void }) {
  return (
    <PageFrame width="narrow">
      <div className={styles.loadingPanel}>
        <Panel>
          <Stack space={4}>
            <Alert title="Não foi possível carregar esta página" variant="error">
              O serviço está temporariamente indisponível. Nenhum dado foi enviado.
            </Alert>
            <Button onClick={reset} variant="secondary">
              Tentar novamente
            </Button>
          </Stack>
        </Panel>
      </div>
    </PageFrame>
  );
}
