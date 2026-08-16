import "server-only";

import {
  ownerCommandSchema,
  profileCompleteCommandSchema,
  profileUpdateCommandSchema,
  type OwnerCommand,
} from "@set-livre/contracts";
import { z } from "zod";

import { executePrivateIdentityCommand } from "@/domains/identity/server/private-identity-command-handler";
import type { PrivateCommandContext } from "./private-command-context";

export const privateCommandSchema = z.discriminatedUnion("action", [
  profileCompleteCommandSchema,
  profileUpdateCommandSchema,
  ...ownerCommandSchema.options,
]);

export type PrivateCommand = z.infer<typeof privateCommandSchema>;

type OwnerCommandHandler = (
  command: OwnerCommand,
  context: PrivateCommandContext,
) => Promise<unknown>;

export type PrivateCommandDependencies = Readonly<{
  executeOwnerCommand: OwnerCommandHandler;
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
    }
  };
}
