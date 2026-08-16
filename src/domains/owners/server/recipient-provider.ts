import "server-only";

import { z } from "zod";

import type {
  RecipientOnboardingCapability,
  RecipientRequirement,
  RecipientStatus,
} from "@set-livre/contracts";

type RecipientProviderOperation = "refresh" | "start";

type RecipientProviderInput = Readonly<{
  deadlineAt: number;
  operation: RecipientProviderOperation;
  operationId: string;
  providerReference: string | null;
  signal: AbortSignal;
}>;

export type RecipientProviderResult = Readonly<{
  providerReference: string;
  requirements: readonly RecipientRequirement[];
  status: Exclude<RecipientStatus, "not_started">;
}>;

export interface RecipientOnboardingProvider {
  execute(input: RecipientProviderInput): Promise<RecipientProviderResult>;
}

export const localRecipientTestFixtureReferences = {
  blocked: "local-test-fixture:blocked",
  refused: "local-test-fixture:refused",
  suspended: "local-test-fixture:suspended",
  timeout: "local-test-fixture:timeout",
  unavailable: "local-test-fixture:unavailable",
} as const;

const localTestFixturePrefix = "local-test-fixture:";
const appEnvironmentSchema = z.enum(["development", "local", "production", "test"]);

const rawLocalRecipientSnapshotSchema = z.strictObject({
  reference: z.string().min(1).max(200),
  requirementCodes: z.array(z.string()).max(3),
  statusCode: z.string(),
});

const localStatusMap: ReadonlyMap<string, Exclude<RecipientStatus, "not_started">> = new Map([
  ["ACTIVE", "active"],
  ["BLOCKED", "blocked"],
  ["PENDING", "pending"],
  ["REFUSED", "refused"],
  ["SUSPENDED", "suspended"],
]);

const localRequirementMap: ReadonlyMap<string, RecipientRequirement> = new Map([
  ["ADDITIONAL_INFORMATION", "additional_information"],
  ["IDENTITY_REVIEW", "identity_review"],
  ["PROVIDER_CONTACT", "provider_contact"],
]);

export function deriveRecipientOnboardingCapability(
  appEnvironment: string | undefined,
): RecipientOnboardingCapability {
  const parsedEnvironment = appEnvironmentSchema.safeParse(appEnvironment);
  if (!parsedEnvironment.success) return "unavailable";
  return parsedEnvironment.data === "local" || parsedEnvironment.data === "test"
    ? "local_adapter"
    : "unavailable";
}

export function readRecipientOnboardingCapability(): RecipientOnboardingCapability {
  return deriveRecipientOnboardingCapability(process.env.APP_ENV);
}

export function mapLocalRecipientSnapshot(raw: unknown): RecipientProviderResult {
  const snapshot = rawLocalRecipientSnapshotSchema.parse(raw);
  const status = localStatusMap.get(snapshot.statusCode);
  if (status === undefined) {
    throw new Error("O adapter retornou um status não autorizado.");
  }

  const requirements = snapshot.requirementCodes.map((code) => {
    const requirement = localRequirementMap.get(code);
    if (requirement === undefined) {
      throw new Error("O adapter retornou um requisito não autorizado.");
    }
    return requirement;
  });
  if (new Set(requirements).size !== requirements.length) {
    throw new Error("O adapter retornou requisitos repetidos.");
  }
  return { providerReference: snapshot.reference, requirements, status };
}

function assertProviderDeadline(input: Pick<RecipientProviderInput, "deadlineAt" | "signal">) {
  if (input.signal.aborted || Date.now() >= input.deadlineAt) {
    throw new DOMException("A operação do adapter expirou.", "AbortError");
  }
}

function timeoutFixture(input: Pick<RecipientProviderInput, "deadlineAt" | "signal">) {
  return new Promise<never>((_resolve, reject) => {
    const rejectAsTimeout = () => {
      clearTimeout(deadline);
      input.signal.removeEventListener("abort", rejectAsTimeout);
      reject(new DOMException("A operação do adapter expirou.", "AbortError"));
    };
    const deadline = setTimeout(rejectAsTimeout, Math.max(0, input.deadlineAt - Date.now()));
    input.signal.addEventListener("abort", rejectAsTimeout, { once: true });
  });
}

function testFixtureSnapshot(
  providerReference: string,
  input: Pick<RecipientProviderInput, "deadlineAt" | "signal">,
) {
  switch (providerReference) {
    case localRecipientTestFixtureReferences.refused:
      return mapLocalRecipientSnapshot({
        reference: providerReference,
        requirementCodes: ["ADDITIONAL_INFORMATION"],
        statusCode: "REFUSED",
      });
    case localRecipientTestFixtureReferences.suspended:
      return mapLocalRecipientSnapshot({
        reference: providerReference,
        requirementCodes: ["PROVIDER_CONTACT"],
        statusCode: "SUSPENDED",
      });
    case localRecipientTestFixtureReferences.blocked:
      return mapLocalRecipientSnapshot({
        reference: providerReference,
        requirementCodes: ["PROVIDER_CONTACT"],
        statusCode: "BLOCKED",
      });
    case localRecipientTestFixtureReferences.unavailable:
      throw new Error("A fixture local simulou indisponibilidade do adapter.");
    case localRecipientTestFixtureReferences.timeout:
      return timeoutFixture(input);
    default:
      throw new Error("A referência de fixture local não pertence à allowlist.");
  }
}

export function createLocalRecipientOnboardingProvider(): RecipientOnboardingProvider {
  const appEnvironment = process.env.APP_ENV;
  if (deriveRecipientOnboardingCapability(appEnvironment) !== "local_adapter") {
    throw new Error("O adapter local de recebedor é proibido fora de local/test.");
  }

  return {
    async execute(input) {
      assertProviderDeadline(input);
      await Promise.resolve();
      assertProviderDeadline(input);

      if (input.operation === "start") {
        return mapLocalRecipientSnapshot({
          reference: `local-recipient:${input.operationId}`,
          requirementCodes: ["IDENTITY_REVIEW"],
          statusCode: "PENDING",
        });
      }
      if (input.providerReference === null) {
        throw new Error("A atualização exige uma referência privada já preparada.");
      }
      if (input.providerReference.startsWith(localTestFixturePrefix)) {
        if (appEnvironment !== "test") {
          throw new Error("Fixtures do adapter de recebedor são proibidas fora de teste.");
        }
        return testFixtureSnapshot(input.providerReference, input);
      }
      return mapLocalRecipientSnapshot({
        reference: input.providerReference,
        requirementCodes: [],
        statusCode: "ACTIVE",
      });
    },
  };
}
