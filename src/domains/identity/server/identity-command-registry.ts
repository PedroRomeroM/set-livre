import "server-only";

import type { IdentityCommand } from "@set-livre/contracts";

import { registerIdentity } from "./identity-service";

type CommandContext = Readonly<{ requestId: string; userAgent: string | null }>;
type CommandHandler = (command: IdentityCommand, context: CommandContext) => Promise<unknown>;

const commandHandlers = {
  "identity.register": (command, context) => registerIdentity(command.payload, context),
} satisfies Record<IdentityCommand["action"], CommandHandler>;

export function executeIdentityCommand(command: IdentityCommand, context: CommandContext) {
  return commandHandlers[command.action](command, context);
}
