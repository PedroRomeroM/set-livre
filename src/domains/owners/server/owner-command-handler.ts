import "server-only";

import type { OwnerCommand } from "@set-livre/contracts";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError } from "@/lib/server/api-route";

import {
  activateOwner,
  refreshRecipientOnboarding,
  startRecipientOnboarding,
} from "./owner-service";

function assertExpectedScope(context: PrivateCommandContext, expectedScope: string) {
  if (context.session.userId !== expectedScope) {
    throw new ApiRouteError(
      409,
      "SESSION_CHANGED",
      "Sua sessão mudou. Recarregue a página antes de continuar.",
    );
  }
}

export async function executeOwnerCommand(command: OwnerCommand, context: PrivateCommandContext) {
  assertExpectedScope(context, command.expectedScope);
  switch (command.action) {
    case "owner.activate":
      return activateOwner(command, context);
    case "recipient.onboarding.start":
      return startRecipientOnboarding(command, context);
    case "recipient.onboarding.refresh":
      return refreshRecipientOnboarding(command, context);
  }
}
