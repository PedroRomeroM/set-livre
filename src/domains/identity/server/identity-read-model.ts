import "server-only";

import {
  currentLegalDocumentsSchema,
  identityEmailSchema,
  identitySessionSchema,
  type CurrentLegalDocuments,
  type Database,
  type IdentitySession,
} from "@set-livre/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  createAnonymousSupabaseClient,
  createComponentSupabaseClient,
  createRouteSupabaseClient,
} from "@/lib/supabase/server";

const legalRowSchema = z.strictObject({
  body_markdown: z.string().min(1),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  effective_at: z.string(),
  id: z.uuid(),
  kind: z.enum(["terms", "privacy"]),
  source: z.enum(["local_fixture", "approved"]),
  title: z.string().min(1),
  version: z.string().min(1),
});
const identityContextRowSchema = z.strictObject({
  is_complete: z.boolean(),
  person_type: z.enum(["individual", "company"]),
  status: z.enum(["active", "suspended"]),
  user_id: z.uuid(),
});
const claimsSchema = z.object({ email: identityEmailSchema, sub: z.uuid() });

function mapLegalRows(rows: unknown): CurrentLegalDocuments {
  const parsed = z.array(legalRowSchema).length(2).parse(rows);
  const terms = parsed.find((row) => row.kind === "terms");
  const privacy = parsed.find((row) => row.kind === "privacy");
  if (terms === undefined || privacy === undefined) {
    throw new Error("Os dois documentos legais vigentes são obrigatórios.");
  }
  const map = (row: z.infer<typeof legalRowSchema>) => ({
    bodyMarkdown: row.body_markdown,
    contentHash: row.content_hash,
    effectiveAt: new Date(row.effective_at).toISOString(),
    id: row.id,
    kind: row.kind,
    source: row.source,
    title: row.title,
    version: row.version,
  });
  return currentLegalDocumentsSchema.parse({ privacy: map(privacy), terms: map(terms) });
}

export async function readCurrentLegalDocuments() {
  const client = createAnonymousSupabaseClient();
  const { data, error } = await client.rpc("get_current_legal_terms");
  if (error !== null) {
    throw new Error("Não foi possível carregar os documentos legais vigentes.");
  }
  return mapLegalRows(data);
}

export async function readIdentitySessionWithClient(
  client: SupabaseClient<Database>,
): Promise<IdentitySession> {
  const claimsResult = await client.auth.getClaims();
  const claims = claimsSchema.safeParse(claimsResult.data?.claims);
  if (!claims.success || claimsResult.error !== null) {
    return identitySessionSchema.parse({ authenticated: false });
  }

  const { data, error } = await client.rpc("get_own_identity_context").maybeSingle();
  if (error !== null) {
    throw new Error("A sessão não possui um contexto de identidade válido.");
  }
  const context = identityContextRowSchema.parse(data);
  if (context.user_id !== claims.data.sub) {
    throw new Error("O contexto de identidade não corresponde à sessão.");
  }
  return identitySessionSchema.parse({
    authenticated: true,
    email: claims.data.email,
    personType: context.person_type,
    profileCompleted: context.is_complete,
    status: context.status,
    userId: context.user_id,
  });
}

export async function readComponentIdentitySession() {
  return readIdentitySessionWithClient(await createComponentSupabaseClient());
}

export async function readRouteIdentitySession() {
  const routeClient = await createRouteSupabaseClient();
  return {
    ...routeClient,
    session: await readIdentitySessionWithClient(routeClient.client),
  };
}
