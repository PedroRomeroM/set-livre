"use client";

import { Alert, Button, PageFrame, Panel, Stack } from "@set-livre/ui";

import styles from "./owner.module.css";

export function OwnerRouteLoading({ label }: Readonly<{ label: string }>) {
  return (
    <PageFrame aria-busy="true" aria-label={label} width="wide">
      <div className={styles.routeState}>
        <Panel>
          <Alert>{label}</Alert>
        </Panel>
      </div>
    </PageFrame>
  );
}

export function OwnerRouteError({ reset }: Readonly<{ reset: () => void }>) {
  return (
    <PageFrame width="wide">
      <div className={styles.routeState}>
        <Panel>
          <Stack space={4}>
            <Alert title="Não foi possível carregar a área do dono" variant="error">
              O serviço está temporariamente indisponível. Nenhum dado foi enviado.
            </Alert>
            <div className={styles.actions}>
              <Button onClick={reset} variant="secondary">
                Tentar novamente
              </Button>
            </div>
          </Stack>
        </Panel>
      </div>
    </PageFrame>
  );
}
