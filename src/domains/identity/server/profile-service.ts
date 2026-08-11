import "server-only";

import {
  cnpjSchema,
  cpfSchema,
  type IdentitySession,
  type ProfileCompletePayload,
  type ProfileUpdatePayload,
} from "@set-livre/contracts";
import { cookies } from "next/headers";
import { z } from "zod";

import { ApiRouteError, hashPrivateRateLimitValue } from "@/lib/server/api-route";
import { enforceIdentityRateLimit } from "@/lib/server/rate-limit";

import {
  completeMyProfile,
  updateMyProfileAppearance,
  updateMyProfileIdentity,
} from "./profile-dal";
import { mapOwnProfileRow } from "./profile-read-model";
import { writeProfilePreferenceCookie } from "./profile-preference-cookie";

type AuthenticatedIdentitySession = Extract<IdentitySession, { authenticated: true }>;
const databaseErrorSchema = z.object({ code: z.string().optional() });

function assertActiveSession(session: AuthenticatedIdentitySession) {
  if (session.status !== "active") {
    throw new ApiRouteError(
      403,
      "ACCOUNT_SUSPENDED",
      "Esta conta não pode alterar o perfil enquanto estiver suspensa.",
    );
  }
}

function handleProfileDatabaseError(error: unknown): never {
  const parsed = databaseErrorSchema.safeParse(error);
  switch (parsed.success ? parsed.data.code : undefined) {
    case "40001":
      throw new ApiRouteError(
        409,
        "CONFLICT",
        "O perfil foi alterado em outra sessão. Recarregue os dados antes de tentar novamente.",
      );
    case "42501":
      throw new ApiRouteError(
        403,
        "ACCOUNT_SUSPENDED",
        "Esta conta não pode alterar o perfil enquanto estiver suspensa.",
      );
    case "22023":
    case "23514":
      throw new ApiRouteError(
        422,
        "VALIDATION_FAILED",
        "Revise os campos destacados e tente novamente.",
      );
    default:
      throw error;
  }
}

function enforceProfileMutationRateLimit(
  action: "profile.complete" | "profile.update",
  userId: string,
) {
  enforceIdentityRateLimit(action, hashPrivateRateLimitValue(userId), {
    limit: action === "profile.complete" ? 20 : 60,
    windowMs: 60 * 60_000,
  });
}

async function syncProfilePreferenceBestEffort(preference: "dark" | "light" | "system") {
  try {
    writeProfilePreferenceCookie(await cookies(), preference);
  } catch {
    // O banco continua canônico; a UI aplica a resposta e uma leitura posterior tenta sincronizar.
  }
}

export async function completeProfile(
  payload: ProfileCompletePayload,
  session: AuthenticatedIdentitySession,
) {
  assertActiveSession(session);
  enforceProfileMutationRateLimit("profile.complete", session.userId);
  try {
    return mapOwnProfileRow(await completeMyProfile(session.userId, payload), session.userId);
  } catch (error) {
    return handleProfileDatabaseError(error);
  }
}

export async function updateProfile(
  payload: ProfileUpdatePayload,
  session: AuthenticatedIdentitySession,
) {
  assertActiveSession(session);
  enforceProfileMutationRateLimit("profile.update", session.userId);
  if (payload.section === "identity" && payload.taxIdChange.action === "replace") {
    const schema = session.personType === "individual" ? cpfSchema : cnpjSchema;
    const parsedTaxId = schema.safeParse(payload.taxIdChange.value);
    if (!parsedTaxId.success) {
      throw new ApiRouteError(422, "VALIDATION_FAILED", "Revise os campos destacados.", {
        taxId:
          session.personType === "individual"
            ? "Informe um CPF válido."
            : "Informe um CNPJ válido.",
      });
    }
  }
  try {
    const row =
      payload.section === "identity"
        ? await updateMyProfileIdentity(session.userId, payload)
        : await updateMyProfileAppearance(session.userId, payload);
    const result = mapOwnProfileRow(row, session.userId);
    if (payload.section === "appearance") {
      await syncProfilePreferenceBestEffort(result.profile.colorScheme);
    }
    return result;
  } catch (error) {
    return handleProfileDatabaseError(error);
  }
}
