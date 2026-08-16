import "server-only";

import type { IdentityCommand } from "@set-livre/contracts";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError } from "@/lib/server/api-route";

import { completeProfile, updateProfile } from "./profile-service";

export type PrivateIdentityCommand = Extract<
  IdentityCommand,
  { action: "profile.complete" | "profile.update" }
>;

function assertExpectedScope(context: PrivateCommandContext, expectedScope: string) {
  if (context.session.userId !== expectedScope) {
    throw new ApiRouteError(
      409,
      "SESSION_CHANGED",
      "Sua sessão mudou. Recarregue a página antes de continuar.",
    );
  }
}

export function executePrivateIdentityCommand(
  command: PrivateIdentityCommand,
  context: PrivateCommandContext,
) {
  assertExpectedScope(context, command.expectedScope);
  switch (command.action) {
    case "profile.complete":
      return completeProfile(command.payload, context.session);
    case "profile.update":
      return updateProfile(command.payload, context.session);
  }
}
