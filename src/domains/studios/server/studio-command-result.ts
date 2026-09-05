import "server-only";

import { studioCommandResultSchema, type StudioCommand } from "@set-livre/contracts";
import { z } from "zod";

import { ApiRouteError } from "@/lib/server/api-route";

export type StudioCommandResult<T> = Readonly<{
  action: StudioCommand["action"];
  idempotencyKey: string;
  result: T;
}>;

export function assertStudioCommandResultIdentity<
  T extends Pick<StudioCommand, "action" | "idempotencyKey">,
>(attempt: T, expected: Pick<StudioCommand, "action" | "idempotencyKey">) {
  if (
    attempt.action !== expected.action ||
    attempt.idempotencyKey !== expected.idempotencyKey.toLowerCase()
  ) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "A confirmação da tentativa não pôde ser verificada. Repita somente a mesma ação.",
    );
  }
  return attempt;
}

export function parseStudioCommandResult<T extends { scope: string }>(
  rows: readonly unknown[],
  schema: z.ZodType<T>,
  expected: Pick<StudioCommand, "action" | "idempotencyKey"> & { userId: string },
): StudioCommandResult<T> {
  if (rows.length !== 1) throw new Error("O DAL recebeu uma cardinalidade inesperada.");
  const attempt = z
    .strictObject({ result: studioCommandResultSchema(schema) })
    .parse(rows[0]).result;
  if (attempt.result.scope !== expected.userId) {
    throw new Error("A confirmação retornou outro escopo.");
  }
  return assertStudioCommandResultIdentity(attempt, expected);
}
