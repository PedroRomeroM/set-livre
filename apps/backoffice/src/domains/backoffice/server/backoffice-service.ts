import "server-only";

import {
  backofficeCommandSchema,
  backofficeUserQuerySchema,
  type BackofficeCommand,
  type BackofficeUserQuery,
} from "@set-livre/contracts";
import { z } from "zod";

import { BackofficeApiError } from "@/lib/server/api-route";

import {
  listBackofficeTaxonomies,
  listBackofficeUsers,
  revealBackofficeUserPii,
  setBackofficeTaxonomyActive,
  setBackofficeUserRole,
  setBackofficeUserStatus,
  upsertBackofficeTaxonomy,
} from "./backoffice-dal";
import { requireRouteBackofficeSession } from "./backoffice-session";

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

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

export async function readBackofficeUsers(query: BackofficeUserQuery) {
  const route = await requireRouteBackofficeSession();
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

export async function readBackofficeTaxonomies() {
  const route = await requireRouteBackofficeSession();
  try {
    return {
      data: await listBackofficeTaxonomies(route.auth),
      responseHeaders: route.responseHeaders,
    };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function executeBackofficeCommand(commandInput: BackofficeCommand, requestId: string) {
  const command = backofficeCommandSchema.parse(commandInput);
  const route = await requireRouteBackofficeSession();
  if (command.expectedScope !== route.session.scope) {
    throw new BackofficeApiError(
      409,
      "SESSION_CHANGED",
      "A sessão mudou. Recarregue antes de continuar.",
    );
  }
  try {
    let data: unknown;
    switch (command.action) {
      case "backoffice.user.setStatus":
        data = await setBackofficeUserStatus({ auth: route.auth, command, requestId });
        break;
      case "backoffice.user.revealPii":
        data = await revealBackofficeUserPii({ auth: route.auth, command, requestId });
        break;
      case "backoffice.access.setRole":
        data = await setBackofficeUserRole({ auth: route.auth, command, requestId });
        break;
      case "backoffice.taxonomy.upsert":
        data = await upsertBackofficeTaxonomy({ auth: route.auth, command, requestId });
        break;
      case "backoffice.taxonomy.setActive":
        data = await setBackofficeTaxonomyActive({ auth: route.auth, command, requestId });
        break;
    }
    return { data, responseHeaders: route.responseHeaders };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}
