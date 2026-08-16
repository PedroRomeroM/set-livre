import type { OwnerActivationResult, OwnerRecipientResult } from "@set-livre/contracts";

export function ownerActivationAvailable(result: OwnerActivationResult) {
  return result.ownerActivationCapability === "available";
}

export function ownerHasCurrentContract(result: OwnerRecipientResult) {
  return (
    result.ownerStatus === "active" &&
    result.ownerContractAccepted &&
    result.acceptedOwnerContractVersionId === result.ownerContract.id
  );
}

export function ownerRecipientActionsAvailable(result: OwnerRecipientResult) {
  return ownerHasCurrentContract(result);
}

export function ownerRecipientOnboardingAvailable(result: OwnerRecipientResult) {
  return result.recipientOnboardingCapability === "local_adapter";
}

export function ownerNeedsCurrentContractAcceptance(result: OwnerRecipientResult) {
  return result.ownerStatus === "active" && !ownerHasCurrentContract(result);
}

export function ownerRecipientProfileNeedsSync(result: OwnerRecipientResult) {
  return (
    ownerHasCurrentContract(result) &&
    result.recipientStatus === "active" &&
    result.profileVersionSynced !== result.profileVersion
  );
}
