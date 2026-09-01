import { Alert } from "@set-livre/ui";

import { OwnerPageFrame } from "@/domains/owners/components/owner-page-frame";
import { StudioPublicationNoScript } from "@/domains/studios/components/studio-publication-no-script";

export default function StudioPublicationLoading() {
  return (
    <OwnerPageFrame
      currentPage="studio-editor"
      description="Confira os fatos do anúncio antes do envio."
      title="Publicação do estúdio"
    >
      <Alert title="Preparando a publicação segura" variant="status">
        Aguarde enquanto validamos o acesso e carregamos os controles privados desta página.
      </Alert>
      <StudioPublicationNoScript />
    </OwnerPageFrame>
  );
}
