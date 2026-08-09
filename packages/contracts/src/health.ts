import { z } from "zod";

export const healthStatusSchema = z.enum(["live", "ready", "unready"]);
export const healthReleaseSchema = z.union([
  z.literal("local"),
  z.string().regex(/^[0-9a-f]{40}$/),
]);
export const requestIdSchema = z.uuid();

const healthPayloadBase = {
  application: z.enum(["web", "backoffice"]),
  checkedAt: z.iso.datetime(),
};
const unavailableHealthRelease = "unknown" as const;

export const healthPayloadSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...healthPayloadBase,
    release: healthReleaseSchema,
    requestId: requestIdSchema,
    status: z.literal("live"),
  }),
  z.strictObject({
    ...healthPayloadBase,
    release: healthReleaseSchema,
    requestId: requestIdSchema,
    status: z.literal("ready"),
  }),
  z.strictObject({
    ...healthPayloadBase,
    release: z.union([healthReleaseSchema, z.literal(unavailableHealthRelease)]),
    requestId: requestIdSchema,
    status: z.literal("unready"),
  }),
]);

export type HealthPayload = z.infer<typeof healthPayloadSchema>;
export type ReadinessResult = {
  headers: Readonly<{
    "cache-control": "no-store";
    "x-request-id": string;
  }>;
  payload: HealthPayload;
  status: 200 | 503;
};

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

export async function evaluateReadiness(
  application: HealthPayload["application"],
  requestId: string,
  releaseCandidate: unknown,
  dependencyCheck: () => boolean | Promise<boolean>,
  checkedAt = new Date(),
): Promise<ReadinessResult> {
  const parsedRelease = healthReleaseSchema.safeParse(releaseCandidate);
  let ready = false;

  if (parsedRelease.success) {
    try {
      ready = await dependencyCheck();
    } catch {
      ready = false;
    }
  }

  return {
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
    payload: createHealthPayload(
      application,
      ready ? "ready" : "unready",
      requestId,
      parsedRelease.success ? parsedRelease.data : unavailableHealthRelease,
      checkedAt,
    ),
    status: ready ? 200 : 503,
  };
}

export function resolveRequestId(candidate: string | null) {
  const parsed = requestIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : crypto.randomUUID();
}
