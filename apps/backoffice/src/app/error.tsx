"use client";

import { Alert, AuthFrame, Button, Stack } from "@set-livre/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useTransition } from "react";

import { useBackofficeHydrated } from "../domains/backoffice/components/use-backoffice-hydrated";

export default function BackofficeError({
  retry,
}: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  const interactive = useBackofficeHydrated();
  const queryClient = useQueryClient();
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    queryClient.clear();
  }, [queryClient]);

  return (
    <AuthFrame
      description="O conteúdo privado permanece fechado até uma nova verificação de acesso."
      eyebrow="Set Livre"
      title="Não foi possível carregar o backoffice"
    >
      <Stack>
        <Alert variant="error">
          Tente novamente. Se a falha continuar, aguarde alguns instantes.
        </Alert>
        <Button
          disabled={!interactive}
          loading={retrying}
          loadingLabel="Verificando acesso"
          onClick={() => startRetry(retry)}
        >
          Tentar novamente
        </Button>
        <noscript>Habilite o JavaScript e recarregue a página para verificar seu acesso.</noscript>
      </Stack>
    </AuthFrame>
  );
}
