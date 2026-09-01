import "server-only";

import type { StudioCommand } from "@set-livre/contracts";

import type { PrivateCommandContext } from "@/domains/commands/server/private-command-context";
import { ApiRouteError } from "@/lib/server/api-route";

import {
  createStudio,
  discardStudio,
  updateStudioContent,
  updateStudioCore,
  updateStudioTaxonomy,
} from "./studio-service";
import { executeStudioMediaCommand } from "./studio-media-service";
import { executeStudioPublicationCommand } from "./studio-publication-service";

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
    case "studio.revision.updateTaxonomy":
      return updateStudioTaxonomy(command, context);
    case "studio.revision.updateContent":
      return updateStudioContent(command, context);
    case "studio.draft.discard":
      return discardStudio(command, context);
    case "studio.revision.submit":
    case "studio.pause":
    case "studio.resume":
      return executeStudioPublicationCommand(command, context);
    case "studio.media.upload.prepare":
    case "studio.media.upload.finalize":
    case "studio.media.reorder":
    case "studio.media.cover.set":
    case "studio.media.delete":
      return executeStudioMediaCommand(command, context);
  }
}
