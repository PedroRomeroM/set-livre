import { z } from "zod";

export const healthStatusSchema = z.enum(["live", "ready", "unready"]);
export const healthReleaseSchema = z.union([
  z.literal("local"),
  z.string().regex(/^[0-9a-f]{40}$/),
]);
export const requestIdSchema = z.uuid();

export const healthPayloadSchema = z.strictObject({
  application: z.enum(["web", "backoffice"]),
  checkedAt: z.iso.datetime(),
  release: healthReleaseSchema,
  requestId: requestIdSchema,
  status: healthStatusSchema,
});

export type HealthPayload = z.infer<typeof healthPayloadSchema>;

export function createHealthPayload(
  application: HealthPayload["application"],
  status: HealthPayload["status"],
  requestId: string,
  release: string,
  checkedAt = new Date(),
): HealthPayload {
  return healthPayloadSchema.parse({
    application,
    checkedAt: checkedAt.toISOString(),
    release,
    requestId,
    status,
  });
}

export function resolveRequestId(candidate: string | null) {
  const parsed = requestIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : crypto.randomUUID();
}
