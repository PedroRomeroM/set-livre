import { Alert } from "@set-livre/ui";

export function StudioPublicationNoScript() {
  return (
    <noscript>
      <Alert title="JavaScript necessário" variant="error">
        Ative o JavaScript e recarregue a página para gerenciar a publicação do estúdio.
      </Alert>
    </noscript>
  );
}
