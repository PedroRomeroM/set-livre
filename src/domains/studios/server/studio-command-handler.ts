import "server-only";

import type { StudioCommand } from "@set-livre/contracts";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError } from "@/lib/server/api-route";

import { createStudio, discardStudioDraft, updateStudioCore } from "./studio-service";

function assertExpectedScope(context: PrivateCommandContext, expectedScope: string) {
  if (context.session.userId !== expectedScope) {
    throw new ApiRouteError(
      409,
      "SESSION_CHANGED",
      "Sua sessão mudou. Recarregue a página antes de continuar.",
    );
  }
}

export async function executeStudioCommand(command: StudioCommand, context: PrivateCommandContext) {
  assertExpectedScope(context, command.expectedScope);
  switch (command.action) {
    case "studio.create":
      return createStudio(command, context);
    case "studio.revision.updateCore":
      return updateStudioCore(command, context);
    case "studio.draft.discard":
      return discardStudioDraft(command, context);
  }
}
