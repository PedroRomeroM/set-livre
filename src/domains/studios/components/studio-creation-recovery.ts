import { studioCreateCommandSchema, type StudioCommand } from "@set-livre/contracts";
import { z } from "zod";

type StudioCreateCommand = Extract<StudioCommand, { action: "studio.create" }>;

export type StudioCreationRecoveryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function resolveStudioCreationRecoveryStorage(
  browserWindow: Pick<Window, "sessionStorage">,
): StudioCreationRecoveryStorage | undefined {
  try {
    return browserWindow.sessionStorage;
  } catch {
    return undefined;
  }
}

export type StudioCreationRecoveryRecord = Readonly<{
  command: StudioCreateCommand;
  createdStudioId: string | null;
  version: 1;
}>;

export type StudioCreationRecoveryRead =
  | Readonly<{ state: "empty" }>
  | Readonly<{ record: StudioCreationRecoveryRecord; state: "found" }>
  | Readonly<{ state: "invalid" }>
  | Readonly<{ state: "unavailable" }>;

const recoveryRecordSchema = z.strictObject({
  command: studioCreateCommandSchema,
  createdStudioId: z.uuid().nullable(),
  version: z.literal(1),
});
const recoveryStorageKeyPrefix = "set-livre:studio-create:v1:";

function recoveryStorageKey(userId: string) {
  return `${recoveryStorageKeyPrefix}${userId}`;
}

export function readStudioCreationRecovery(
  storage: StudioCreationRecoveryStorage | undefined,
  userId: string,
): StudioCreationRecoveryRead {
  if (storage === undefined) return { state: "unavailable" };
  const parsedUserId = z.uuid().safeParse(userId);
  if (!parsedUserId.success) return { state: "invalid" };

  let serialized: string | null;
  try {
    serialized = storage.getItem(recoveryStorageKey(parsedUserId.data));
  } catch {
    return { state: "unavailable" };
  }
  if (serialized === null) return { state: "empty" };

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return { state: "invalid" };
  }
  const parsed = recoveryRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.command.expectedScope !== parsedUserId.data) {
    return { state: "invalid" };
  }
  return { record: parsed.data, state: "found" };
}

export function writeStudioCreationRecovery(
  storage: StudioCreationRecoveryStorage | undefined,
  record: StudioCreationRecoveryRecord,
) {
  const parsed = recoveryRecordSchema.parse(record);
  if (storage === undefined) return false;
  try {
    storage.setItem(recoveryStorageKey(parsed.command.expectedScope), JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

export function clearStudioCreationAttempt(
  storage: StudioCreationRecoveryStorage | undefined,
  userId: string,
  idempotencyKey: string,
) {
  if (storage === undefined) return false;
  const current = readStudioCreationRecovery(storage, userId);
  if (current.state !== "found" || current.record.command.idempotencyKey !== idempotencyKey) {
    return false;
  }
  try {
    storage.removeItem(recoveryStorageKey(userId));
    return true;
  } catch {
    return false;
  }
}

export function consumeResolvedStudioCreation(
  storage: StudioCreationRecoveryStorage | undefined,
  userId: string,
  studioId: string,
) {
  if (storage === undefined) return false;
  const current = readStudioCreationRecovery(storage, userId);
  if (current.state !== "found" || current.record.createdStudioId !== studioId) {
    return false;
  }
  try {
    storage.removeItem(recoveryStorageKey(userId));
    return true;
  } catch {
    return false;
  }
}
