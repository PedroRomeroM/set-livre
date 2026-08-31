import "server-only";

import {
  ownerCommandSchema,
  profileCompleteCommandSchema,
  profileUpdateCommandSchema,
  studioCommandSchema,
  type OwnerCommand,
  type StudioCommand,
} from "@set-livre/contracts";
import { z } from "zod";

import { executePrivateIdentityCommand } from "@/domains/identity/server/private-identity-command-handler";
import type { PrivateCommandContext } from "./private-command-context";

export const privateCommandSchema = z.discriminatedUnion("action", [
  profileCompleteCommandSchema,
  profileUpdateCommandSchema,
  ...ownerCommandSchema.options,
  ...studioCommandSchema.options,
]);

export type PrivateCommand = z.infer<typeof privateCommandSchema>;

type OwnerCommandHandler = (
  command: OwnerCommand,
  context: PrivateCommandContext,
) => Promise<unknown>;

type StudioCommandHandler = (
  command: StudioCommand,
  context: PrivateCommandContext,
) => Promise<unknown>;

export type PrivateCommandDependencies = Readonly<{
  executeOwnerCommand: OwnerCommandHandler;
  executeStudioCommand: StudioCommandHandler;
}>;

export function createPrivateCommandRegistry(dependencies: PrivateCommandDependencies) {
  return function executePrivateCommand(command: PrivateCommand, context: PrivateCommandContext) {
    switch (command.action) {
      case "profile.complete":
      case "profile.update":
        return executePrivateIdentityCommand(command, context);
      case "owner.activate":
      case "recipient.onboarding.start":
      case "recipient.onboarding.refresh":
        return dependencies.executeOwnerCommand(command, context);
      case "studio.create":
      case "studio.revision.updateCore":
      case "studio.revision.updateTaxonomy":
      case "studio.revision.updateContent":
      case "studio.draft.discard":
      case "studio.media.upload.prepare":
      case "studio.media.upload.finalize":
      case "studio.media.reorder":
      case "studio.media.cover.set":
      case "studio.media.delete":
        return dependencies.executeStudioCommand(command, context);
    }
  };
}
