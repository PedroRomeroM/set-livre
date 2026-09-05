import { describe, expect, it } from "vitest";

import {
  clearStudioCreationAttempt,
  consumeResolvedStudioCreation,
  readStudioCreationRecovery,
  resolveStudioCreationRecoveryStorage,
  writeStudioCreationRecovery,
  type StudioCreationRecoveryStorage,
} from "../../src/domains/studios/components/studio-creation-recovery";
import { studioCoreFixture, studioTestIds } from "./studio-test-fixture";

function memoryStorage() {
  const entries = new Map<string, string>();
  const storage: StudioCreationRecoveryStorage = {
    getItem: (key) => entries.get(key) ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
  return { entries, storage };
}

const command = {
  action: "studio.create",
  expectedScope: studioTestIds.userId,
  idempotencyKey: studioTestIds.idempotencyKey,
  payload: studioCoreFixture,
} as const;

describe("studio creation recovery", () => {
  it("round-trips the exact pending command and consumes only its resolved editor", () => {
    const { storage } = memoryStorage();

    expect(
      writeStudioCreationRecovery(storage, {
        command,
        createdStudioId: null,
        version: 1,
      }),
    ).toBe(true);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({
      record: { command, createdStudioId: null, version: 1 },
      state: "found",
    });
    expect(
      consumeResolvedStudioCreation(storage, studioTestIds.userId, studioTestIds.studioId),
    ).toBe(false);

    expect(
      writeStudioCreationRecovery(storage, {
        command,
        createdStudioId: studioTestIds.studioId,
        version: 1,
      }),
    ).toBe(true);
    expect(
      consumeResolvedStudioCreation(storage, studioTestIds.userId, studioTestIds.otherStudioId),
    ).toBe(false);
    expect(
      consumeResolvedStudioCreation(storage, studioTestIds.userId, studioTestIds.studioId),
    ).toBe(true);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({ state: "empty" });
  });

  it("clears a conclusively rejected attempt only when its idempotency identity matches", () => {
    const { storage } = memoryStorage();
    writeStudioCreationRecovery(storage, { command, createdStudioId: null, version: 1 });

    expect(
      clearStudioCreationAttempt(
        storage,
        studioTestIds.userId,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toBe(false);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId).state).toBe("found");
    expect(
      clearStudioCreationAttempt(storage, studioTestIds.userId, studioTestIds.idempotencyKey),
    ).toBe(true);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({ state: "empty" });
  });

  it("retains the original pending command when confirmation exceeds quota and retries its persistence", () => {
    const { storage } = memoryStorage();
    const pending = { command, createdStudioId: null, version: 1 } as const;
    const resolved = { ...pending, createdStudioId: studioTestIds.studioId };
    expect(writeStudioCreationRecovery(storage, pending)).toBe(true);
    const fullStorage: StudioCreationRecoveryStorage = {
      ...storage,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };

    expect(writeStudioCreationRecovery(fullStorage, resolved)).toBe(false);
    expect(readStudioCreationRecovery(fullStorage, studioTestIds.userId)).toEqual({
      record: pending,
      state: "found",
    });
    expect(
      consumeResolvedStudioCreation(fullStorage, studioTestIds.userId, resolved.createdStudioId),
    ).toBe(false);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({
      record: pending,
      state: "found",
    });

    expect(writeStudioCreationRecovery(storage, resolved)).toBe(true);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({
      record: resolved,
      state: "found",
    });
    const removalDeniedStorage: StudioCreationRecoveryStorage = {
      ...storage,
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    expect(
      consumeResolvedStudioCreation(
        removalDeniedStorage,
        studioTestIds.userId,
        resolved.createdStudioId,
      ),
    ).toBe(false);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({
      record: resolved,
      state: "found",
    });
    expect(
      consumeResolvedStudioCreation(storage, studioTestIds.userId, resolved.createdStudioId),
    ).toBe(true);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({ state: "empty" });
  });

  it("isolates recovery by scope and refuses to consume a record copied from another owner", () => {
    const { storage } = memoryStorage();
    const resolved = { command, createdStudioId: studioTestIds.studioId, version: 1 } as const;
    expect(writeStudioCreationRecovery(storage, resolved)).toBe(true);
    expect(readStudioCreationRecovery(storage, studioTestIds.otherUserId)).toEqual({
      state: "empty",
    });
    expect(
      consumeResolvedStudioCreation(storage, studioTestIds.otherUserId, studioTestIds.studioId),
    ).toBe(false);

    storage.setItem(
      `set-livre:studio-create:v1:${studioTestIds.otherUserId}`,
      JSON.stringify(resolved),
    );
    expect(readStudioCreationRecovery(storage, studioTestIds.otherUserId)).toEqual({
      state: "invalid",
    });
    expect(
      consumeResolvedStudioCreation(storage, studioTestIds.otherUserId, studioTestIds.studioId),
    ).toBe(false);
    expect(
      clearStudioCreationAttempt(storage, studioTestIds.otherUserId, command.idempotencyKey),
    ).toBe(false);
    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({
      record: resolved,
      state: "found",
    });
  });

  it("fails closed for malformed or unavailable storage", () => {
    const { entries, storage } = memoryStorage();
    writeStudioCreationRecovery(storage, { command, createdStudioId: null, version: 1 });
    const key = entries.keys().next().value;
    expect(key).toBeTypeOf("string");
    entries.set(String(key), "{");

    expect(readStudioCreationRecovery(storage, studioTestIds.userId)).toEqual({ state: "invalid" });
    expect(
      readStudioCreationRecovery(
        {
          getItem: () => {
            throw new DOMException("blocked", "SecurityError");
          },
          removeItem: () => undefined,
          setItem: () => undefined,
        },
        studioTestIds.userId,
      ),
    ).toEqual({ state: "unavailable" });
    const deniedWindow = Object.defineProperty({}, "sessionStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    }) as Pick<Window, "sessionStorage">;
    const unavailableStorage = resolveStudioCreationRecoveryStorage(deniedWindow);
    expect(unavailableStorage).toBeUndefined();
    expect(readStudioCreationRecovery(unavailableStorage, studioTestIds.userId)).toEqual({
      state: "unavailable",
    });
    expect(
      writeStudioCreationRecovery(unavailableStorage, {
        command,
        createdStudioId: null,
        version: 1,
      }),
    ).toBe(false);
    expect(
      clearStudioCreationAttempt(
        unavailableStorage,
        studioTestIds.userId,
        studioTestIds.idempotencyKey,
      ),
    ).toBe(false);
    expect(
      consumeResolvedStudioCreation(
        unavailableStorage,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toBe(false);
    expect(
      writeStudioCreationRecovery(
        {
          getItem: () => null,
          removeItem: () => undefined,
          setItem: () => {
            throw new DOMException("full", "QuotaExceededError");
          },
        },
        { command, createdStudioId: null, version: 1 },
      ),
    ).toBe(false);

    expect(
      writeStudioCreationRecovery(storage, {
        command,
        createdStudioId: null,
        version: 1,
      }),
    ).toBe(true);
    expect(
      clearStudioCreationAttempt(
        {
          getItem: storage.getItem,
          removeItem: () => {
            throw new DOMException("blocked", "SecurityError");
          },
          setItem: storage.setItem,
        },
        studioTestIds.userId,
        studioTestIds.idempotencyKey,
      ),
    ).toBe(false);
  });
});
