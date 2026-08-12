import "server-only";

import type { IdentityCommand, IdentitySession } from "@set-livre/contracts";

import { ApiRouteError } from "@/lib/server/api-route";

import { registerIdentity } from "./identity-service";
import { completeProfile, updateProfile } from "./profile-service";

type AuthenticatedIdentitySession = Extract<IdentitySession, { authenticated: true }>;
type CommandContext = Readonly<{
  requestId: string;
  session?: AuthenticatedIdentitySession | undefined;
  userAgent: string | null;
}>;

function authenticatedSession(context: CommandContext) {
  if (context.session === undefined) {
    throw new Error("O registry recebeu um comando privado sem sessão autenticada.");
  }
  return context.session;
}

function authenticatedSessionForExpectedScope(context: CommandContext, expectedScope: string) {
  const session = authenticatedSession(context);
  if (session.userId !== expectedScope) {
    throw new ApiRouteError(
      409,
      "SESSION_CHANGED",
      "Sua sessão mudou. Recarregue a página antes de continuar.",
    );
  }
  return session;
}

export function executeIdentityCommand(command: IdentityCommand, context: CommandContext) {
  switch (command.action) {
    case "identity.register":
      return registerIdentity(command.payload, context);
    case "profile.complete":
      return completeProfile(
        command.payload,
        authenticatedSessionForExpectedScope(context, command.expectedScope),
      );
    case "profile.update":
      return updateProfile(
        command.payload,
        authenticatedSessionForExpectedScope(context, command.expectedScope),
      );
  }
}
