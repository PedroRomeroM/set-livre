import { redirect } from "next/navigation";

import { TaxonomyManager } from "@/domains/backoffice/components/taxonomy-manager";
import { readComponentBackofficeSession } from "@/domains/backoffice/server/backoffice-session";

export default async function BackofficeTaxonomiesPage() {
  const session = await readComponentBackofficeSession();
  if (!session.authenticated) return null;
  if (!session.roles.includes("admin")) redirect("/usuarios");
  return <TaxonomyManager session={session} />;
}
