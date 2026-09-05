import type { PlatformRole } from "@set-livre/contracts";

export function canManageBackofficeUsers(roles: readonly PlatformRole[]) {
  return roles.includes("support") || roles.includes("admin");
}

export function canReviewBackofficeStudios(roles: readonly PlatformRole[]) {
  return roles.includes("reviewer") || roles.includes("admin");
}

export function backofficeLandingPath(roles: readonly PlatformRole[]) {
  return canManageBackofficeUsers(roles) ? "/usuarios" : "/estudios";
}
