import type { Metadata } from "next";

import { LegalDocumentView } from "@/domains/identity/components/legal-document-view";
import { readCurrentLegalDocuments } from "@/domains/identity/server/identity-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Consulte a versão vigente da Política de Privacidade da Set Livre.",
  title: "Política de Privacidade",
};

export default async function PrivacyPage() {
  const legalDocuments = await readCurrentLegalDocuments();
  return <LegalDocumentView document={legalDocuments.privacy} />;
}
