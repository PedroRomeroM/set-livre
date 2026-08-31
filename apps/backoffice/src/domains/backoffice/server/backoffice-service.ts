import "server-only";

import {
  backofficeCommandSchema,
  backofficeUserQuerySchema,
  type BackofficeCommand,
  type BackofficeUserQuery,
} from "@set-livre/contracts";
import { z } from "zod";

import { BackofficeApiError } from "@/lib/server/api-route";

import type { BackofficeAuthContext } from "./auth-context";
import {
  getBackofficeUserAccess,
  listBackofficeTaxonomies,
  listBackofficeUsers,
  revealBackofficeUserPii,
  transitionBackofficeTaxonomy,
  setBackofficeUserRole,
  setBackofficeUserStatus,
  upsertBackofficeTaxonomy,
} from "./backoffice-dal";
import type { RequiredRouteBackofficeSession } from "./backoffice-session";
import { requireBackofficeRuntimeUnlock } from "./runtime-unlock";

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});
const staleStateMessages = new Set([
  "backoffice_account_version_conflict",
  "backoffice_role_result_stale",
  "backoffice_roles_conflict",
  "backoffice_taxonomy_result_stale",
  "backoffice_taxonomy_version_conflict",
  "backoffice_user_status_result_stale",
]);

function translateBackofficeDatabaseError(error: unknown): never {
  const parsed = databaseErrorSchema.safeParse(error);
  if (!parsed.success) throw error;
  const { code, message } = parsed.data;
  if (code === "P0002") {
    throw new BackofficeApiError(404, "NOT_FOUND", "O registro solicitado não existe mais.");
  }
  if (message === "backoffice_reauthentication_required") {
    throw new BackofficeApiError(
      409,
      "REAUTHENTICATION_REQUIRED",
      "Confirme sua senha novamente para alterar acessos.",
    );
  }
  if (
    message === "backoffice_session_expired" ||
    message === "backoffice_auth_session_invalid" ||
    message === "backoffice_profile_ineligible"
  ) {
    throw new BackofficeApiError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
  }
  if (code === "42501") {
    throw new BackofficeApiError(403, "FORBIDDEN", "Você não possui permissão para esta ação.");
  }
  if (code === "40001" && message !== undefined && staleStateMessages.has(message)) {
    throw new BackofficeApiError(
      409,
      "STALE_STATE",
      "Os dados mudaram. O estado atual será recarregado para uma nova revisão.",
    );
  }
  if (code === "40001" || code === "23505" || code === "23514") {
    throw new BackofficeApiError(
      409,
      "CONFLICT",
      "Os dados mudaram ou a operação viola uma salvaguarda. Recarregue e revise o impacto.",
    );
  }
  if (code === "22023") {
    throw new BackofficeApiError(
      422,
      "VALIDATION_FAILED",
      "Os dados enviados não atendem ao contrato da operação.",
    );
  }
  throw error;
}

export async function readBackofficeUsers(
  route: RequiredRouteBackofficeSession,
  query: BackofficeUserQuery,
) {
  try {
    return {
      data: await listBackofficeUsers({
        auth: route.auth,
        ...backofficeUserQuerySchema.parse(query),
      }),
      responseHeaders: route.responseHeaders,
    };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function readBackofficeTaxonomies(route: RequiredRouteBackofficeSession) {
  try {
    return {
      data: await listBackofficeTaxonomies(route.auth),
      responseHeaders: route.responseHeaders,
    };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function readBackofficeUserAccess(input: {
  auth: BackofficeAuthContext;
  userId: string;
}) {
  try {
    return await getBackofficeUserAccess({
      auth: input.auth,
      userId: z.uuid().parse(input.userId),
    });
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function executeBackofficeCommand(
  commandInput: BackofficeCommand,
  context: { requestId: string; route: RequiredRouteBackofficeSession },
) {
  const command = backofficeCommandSchema.parse(commandInput);
  const { requestId, route } = context;
  if (command.expectedScope !== route.session.scope) {
    throw new BackofficeApiError(
      409,
      "SESSION_CHANGED",
      "A sessão mudou. Recarregue antes de continuar.",
    );
  }
  await requireBackofficeRuntimeUnlock(route.auth);
  try {
    let data: unknown;
    switch (command.action) {
      case "backoffice.user.restore":
      case "backoffice.user.suspend":
        data = await setBackofficeUserStatus({ auth: route.auth, command, requestId });
        break;
      case "backoffice.user.revealPii":
        data = await revealBackofficeUserPii({ auth: route.auth, command, requestId });
        break;
      case "backoffice.access.grantAdmin":
      case "backoffice.access.grantSupport":
      case "backoffice.access.revokeAdmin":
      case "backoffice.access.revokeSupport":
        data = await setBackofficeUserRole({ auth: route.auth, command, requestId });
        break;
      case "backoffice.taxonomy.upsert":
        data = await upsertBackofficeTaxonomy({ auth: route.auth, command, requestId });
        break;
      case "backoffice.taxonomy.archive":
      case "backoffice.taxonomy.reactivate":
        data = await transitionBackofficeTaxonomy({ auth: route.auth, command, requestId });
        break;
    }
    return { data, responseHeaders: route.responseHeaders };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}
