import type { Metadata } from "next";

import { LegalDocumentView } from "@/domains/identity/components/legal-document-view";
import { readCurrentLegalDocuments } from "@/domains/identity/server/identity-read-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Consulte a versão vigente dos Termos de Uso da Set Livre.",
  title: "Termos de Uso",
};

export default async function TermsPage() {
  const legalDocuments = await readCurrentLegalDocuments();
  return <LegalDocumentView document={legalDocuments.terms} />;
}
