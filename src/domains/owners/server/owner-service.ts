import "server-only";

import type {
  OwnerActivationResult,
  OwnerCommand,
  OwnerRecipientStatus,
} from "@set-livre/contracts";
import { z } from "zod";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError, hashPrivateRateLimitValue } from "@/lib/server/api-route";
import { hashOptionalPrivateEvidence } from "@/lib/server/private-evidence";
import { enforceIdentityRateLimit } from "@/lib/server/rate-limit";

import {
  activateOwnerProfile,
  applyOwnerRecipientOperation,
  getOwnerRecipientStatusForUser,
  mapOwnerActivationDalRow,
  mapOwnerRecipientStatusDalRow,
  prepareOwnerRecipientOperation,
  type PreparedRecipientOperation,
} from "./owner-dal";
import {
  createLocalRecipientOnboardingProvider,
  readRecipientOnboardingCapability,
  type RecipientOnboardingProvider,
} from "./recipient-provider";

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});
const defaultProviderDeadlineMs = 2_000;

type ActivateOwnerCommand = Extract<OwnerCommand, { action: "owner.activate" }>;
type RecipientCommand = Extract<
  OwnerCommand,
  { action: "recipient.onboarding.refresh" | "recipient.onboarding.start" }
>;

export type OwnerServiceDependencies = Readonly<{
  activateOwnerProfile: typeof activateOwnerProfile;
  applyOwnerRecipientOperation: typeof applyOwnerRecipientOperation;
  createProvider: () => RecipientOnboardingProvider;
  getOwnerRecipientStatusForUser: typeof getOwnerRecipientStatusForUser;
  prepareOwnerRecipientOperation: typeof prepareOwnerRecipientOperation;
  providerDeadlineMs: number;
  readRecipientOnboardingCapability: typeof readRecipientOnboardingCapability;
}>;

const ownerServiceDefaults: OwnerServiceDependencies = {
  activateOwnerProfile,
  applyOwnerRecipientOperation,
  createProvider: createLocalRecipientOnboardingProvider,
  getOwnerRecipientStatusForUser,
  prepareOwnerRecipientOperation,
  providerDeadlineMs: defaultProviderDeadlineMs,
  readRecipientOnboardingCapability,
};

function assertMutableAccount(context: PrivateCommandContext) {
  if (context.session.status !== "active") {
    throw new ApiRouteError(
      403,
      "ACCOUNT_SUSPENDED",
      "Esta conta não pode alterar o cadastro de dono enquanto estiver suspensa.",
    );
  }
  if (!context.session.profileCompleted) {
    throw new ApiRouteError(
      409,
      "CONFLICT",
      "Conclua seu perfil antes de ativar o cadastro de dono.",
    );
  }
}

function assertFixtureContractAllowed(
  source:
    | OwnerActivationResult["ownerContract"]["source"]
    | OwnerRecipientStatus["ownerContract"]["source"],
) {
  if (
    source === "local_fixture" &&
    process.env.APP_ENV !== "local" &&
    process.env.APP_ENV !== "test"
  ) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "A versão aprovada do contrato do dono ainda não está disponível.",
    );
  }
}

function handleOwnerDatabaseError(error: unknown): never {
  const parsed = databaseErrorSchema.safeParse(error);
  const databaseError = parsed.success ? parsed.data : undefined;

  if (databaseError?.code === "42501" && databaseError.message === "owner_contract_not_current") {
    throw new ApiRouteError(
      409,
      "CONFLICT",
      "O cadastro foi atualizado por outra solicitação. Recarregue o estado atual.",
    );
  }

  switch (databaseError?.code) {
    case "22023":
      throw new ApiRouteError(
        422,
        "VALIDATION_FAILED",
        "O cadastro mudou ou os dados não são mais válidos. Atualize a página e tente novamente.",
      );
    case "23514":
    case "40001":
      throw new ApiRouteError(
        409,
        "CONFLICT",
        "O cadastro foi atualizado por outra solicitação. Recarregue o estado atual.",
      );
    case "42501":
      throw new ApiRouteError(
        403,
        "FORBIDDEN",
        "Esta conta não pode executar esta ação no estado atual.",
      );
    case "P0002":
      throw new ApiRouteError(
        409,
        "CONFLICT",
        "O cadastro necessário não está mais disponível. Atualize a página.",
      );
    default:
      throw error;
  }
}

function enforceOwnerMutationRateLimit(action: OwnerCommand["action"], userId: string) {
  enforceIdentityRateLimit(action, hashPrivateRateLimitValue(userId), {
    limit: action === "recipient.onboarding.refresh" ? 60 : 20,
    windowMs: 60 * 60_000,
  });
}

function providerUnavailable(message: string): never {
  throw new ApiRouteError(503, "PAYMENT_PROVIDER_UNAVAILABLE", message);
}

export function createOwnerService(dependencies: OwnerServiceDependencies = ownerServiceDefaults) {
  async function activateOwner(command: ActivateOwnerCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceOwnerMutationRateLimit(command.action, context.session.userId);
    try {
      const recipientOnboardingCapability = dependencies.readRecipientOnboardingCapability();
      const currentRow = await dependencies.getOwnerRecipientStatusForUser(context.session.userId);
      assertFixtureContractAllowed(currentRow.owner_contract_source);
      mapOwnerRecipientStatusDalRow(
        currentRow,
        context.session.userId,
        recipientOnboardingCapability,
      );
      return mapOwnerActivationDalRow(
        await dependencies.activateOwnerProfile({
          idempotencyKey: command.idempotencyKey,
          ownerContractVersionId: command.payload.ownerContractVersionId,
          requestId: context.requestId,
          userAgentHash: hashOptionalPrivateEvidence(context.userAgent),
          userId: context.session.userId,
        }),
        context.session.userId,
        recipientOnboardingCapability,
      );
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleOwnerDatabaseError(error);
    }
  }

  async function executePreparedRecipientOperation(
    context: PrivateCommandContext,
    prepared: PreparedRecipientOperation,
    recipientOnboardingCapability: "local_adapter",
  ) {
    if (prepared.alreadyApplied) {
      try {
        return mapOwnerRecipientStatusDalRow(
          await dependencies.getOwnerRecipientStatusForUser(context.session.userId),
          context.session.userId,
          recipientOnboardingCapability,
        );
      } catch (error) {
        if (error instanceof ApiRouteError) throw error;
        return handleOwnerDatabaseError(error);
      }
    }

    let provider: RecipientOnboardingProvider;
    try {
      provider = dependencies.createProvider();
    } catch {
      return providerUnavailable("O cadastro de recebimentos não está disponível neste ambiente.");
    }

    const abortController = new AbortController();
    const deadlineAt = Date.now() + dependencies.providerDeadlineMs;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let providerResult: Awaited<ReturnType<RecipientOnboardingProvider["execute"]>>;
    try {
      providerResult = await Promise.race([
        provider.execute({
          deadlineAt,
          operation: prepared.operation,
          operationId: prepared.operationId,
          providerReference: prepared.providerReference,
          signal: abortController.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            abortController.abort();
            reject(new DOMException("A operação do adapter expirou.", "AbortError"));
          }, dependencies.providerDeadlineMs);
        }),
      ]);
      if (abortController.signal.aborted || Date.now() >= deadlineAt) {
        throw new DOMException("A operação do adapter expirou.", "AbortError");
      }
    } catch {
      return providerUnavailable(
        "Não foi possível consultar o cadastro de recebimentos agora. Atualize o status antes de tentar novamente.",
      );
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      abortController.abort();
    }

    try {
      return mapOwnerRecipientStatusDalRow(
        await dependencies.applyOwnerRecipientOperation({
          operationId: prepared.operationId,
          provider: "local",
          providerReference: providerResult.providerReference,
          requestId: context.requestId,
          requirements: providerResult.requirements,
          status: providerResult.status,
          userId: context.session.userId,
        }),
        context.session.userId,
        recipientOnboardingCapability,
      );
    } catch (error) {
      if (error instanceof ApiRouteError) throw error;
      return handleOwnerDatabaseError(error);
    }
  }

  async function executeRecipient(command: RecipientCommand, context: PrivateCommandContext) {
    assertMutableAccount(context);
    enforceOwnerMutationRateLimit(command.action, context.session.userId);
    const recipientOnboardingCapability = dependencies.readRecipientOnboardingCapability();
    if (recipientOnboardingCapability !== "local_adapter") {
      return providerUnavailable("O cadastro de recebimentos não está disponível neste ambiente.");
    }
    let prepared: PreparedRecipientOperation;
    try {
      prepared = await dependencies.prepareOwnerRecipientOperation({
        action: command.action,
        idempotencyKey: command.idempotencyKey,
        userId: context.session.userId,
      });
    } catch (error) {
      return handleOwnerDatabaseError(error);
    }
    return executePreparedRecipientOperation(context, prepared, recipientOnboardingCapability);
  }

  return {
    activateOwner,
    refreshRecipientOnboarding: executeRecipient,
    startRecipientOnboarding: executeRecipient,
  };
}

const ownerService = createOwnerService();

export const activateOwner = ownerService.activateOwner;
export const refreshRecipientOnboarding = ownerService.refreshRecipientOnboarding;
export const startRecipientOnboarding = ownerService.startRecipientOnboarding;
