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
import { cookies } from "next/headers";
import { z } from "zod";

import { readSupabaseEnvironment } from "@/lib/supabase/config";
import {
  createAnonymousSupabaseClient,
  createComponentSupabaseClient,
  createRouteSupabaseClient,
} from "@/lib/supabase/server";

import { closeIdentityRecoverySession, inspectIdentityRecoverySession } from "./identity-dal";
import {
  deleteCookieBestEffort,
  parseAuthSessionContext,
  signOutLocalAndClearExactAuthCookies,
} from "./identity-auth-session";
import {
  recoveryGrantCookieName,
  recoverySessionCookieName,
  recoverySessionScopeFromCookieStore,
} from "./recovery-grant";

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
  options: Readonly<{ recoveryBindingChecked?: boolean }> = {},
): Promise<IdentitySession> {
  const claimsResult = await client.auth.getClaims();
  const claims = claimsSchema.safeParse(claimsResult.data?.claims);
  const authContext = parseAuthSessionContext(claimsResult.data?.claims);
  if (!claims.success || claimsResult.error !== null || authContext === undefined) {
    return identitySessionSchema.parse({ authenticated: false });
  }
  if (!options.recoveryBindingChecked) {
    const recoveryBinding = await inspectIdentityRecoverySession({
      authExpiresAt: authContext.authExpiresAt,
      authSessionId: authContext.authSessionId,
      sessionScope: null,
      token: null,
      userId: authContext.userId,
    });
    if (recoveryBinding !== undefined) {
      return identitySessionSchema.parse({ authenticated: false });
    }
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

async function readServerIdentitySession(
  client: SupabaseClient<Database>,
  options: Readonly<{ preserveValidRecovery: boolean }>,
) {
  const claimsResult = await client.auth.getClaims();
  const authContext =
    claimsResult.error === null ? parseAuthSessionContext(claimsResult.data?.claims) : undefined;
  const cookieStore = await cookies();
  const parsedToken = z.uuid().safeParse(cookieStore.get(recoveryGrantCookieName)?.value);
  const token = parsedToken.success ? parsedToken.data : null;
  const cookieScope = recoverySessionScopeFromCookieStore(cookieStore);
  const sessionScope = cookieScope === "anonymous" ? null : cookieScope;
  const hasRecoveryCookies =
    cookieStore.get(recoveryGrantCookieName) !== undefined ||
    cookieStore.get(recoverySessionCookieName) !== undefined;

  if (authContext === undefined) {
    deleteCookieBestEffort(cookieStore, recoveryGrantCookieName);
    deleteCookieBestEffort(cookieStore, recoverySessionCookieName);
    return identitySessionSchema.parse({ authenticated: false });
  }

  let recoveryBinding: Awaited<ReturnType<typeof inspectIdentityRecoverySession>>;
  try {
    recoveryBinding = await inspectIdentityRecoverySession({
      authExpiresAt: authContext.authExpiresAt,
      authSessionId: authContext.authSessionId,
      sessionScope,
      token,
      userId: authContext.userId,
    });
  } catch (error) {
    if (hasRecoveryCookies) {
      deleteCookieBestEffort(cookieStore, recoveryGrantCookieName);
      deleteCookieBestEffort(cookieStore, recoverySessionCookieName);
    }
    throw error;
  }

  if (recoveryBinding !== undefined) {
    const recoveryStillValid =
      recoveryBinding.active &&
      recoveryBinding.grantAllowed &&
      sessionScope === recoveryBinding.sessionScope;
    if (!recoveryStillValid || !options.preserveValidRecovery) {
      try {
        await closeIdentityRecoverySession({
          authSessionId: authContext.authSessionId,
          userId: authContext.userId,
        });
      } catch {
        // O tombstone existente ainda impede que a sessão seja tratada como login comum.
      }
      deleteCookieBestEffort(cookieStore, recoveryGrantCookieName);
      deleteCookieBestEffort(cookieStore, recoverySessionCookieName);
      await signOutLocalAndClearExactAuthCookies({
        auth: client.auth,
        cookieStore,
        supabaseOrigin: readSupabaseEnvironment().supabaseOrigin,
      });
    }
    return identitySessionSchema.parse({ authenticated: false });
  }

  deleteCookieBestEffort(cookieStore, recoveryGrantCookieName);
  deleteCookieBestEffort(cookieStore, recoverySessionCookieName);
  return readIdentitySessionWithClient(client, { recoveryBindingChecked: true });
}

export async function readComponentIdentitySession() {
  return readServerIdentitySession(await createComponentSupabaseClient(), {
    preserveValidRecovery: false,
  });
}

export async function readRouteIdentitySession() {
  const routeClient = await createRouteSupabaseClient();
  return {
    ...routeClient,
    session: await readServerIdentitySession(routeClient.client, {
      preserveValidRecovery: true,
    }),
  };
}
