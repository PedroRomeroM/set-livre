import "server-only";

import { BackofficeApiError, hashBackofficePrivateValue } from "./api-route";

type Bucket = { count: number; limit: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const maximumBuckets = 2_000;

export function backofficeIdentityActionDiscriminator(scope: string, action: string) {
  return hashBackofficePrivateValue(JSON.stringify([scope, action]));
}

function sweepExpired(now: number) {
  let inspected = 0;
  for (const [key, bucket] of buckets) {
    if (inspected >= 16) break;
    if (bucket.resetAt <= now) buckets.delete(key);
    inspected += 1;
  }
}

export function enforceBackofficeRateLimit(
  partition: string,
  discriminator: string,
  options: Readonly<{ limit: number; windowMs: number }>,
) {
  const now = Date.now();
  sweepExpired(now);
  const key = `${partition}:${discriminator}`;
  const existing = buckets.get(key);
  if (existing !== undefined && existing.resetAt > now) {
    existing.limit = Math.min(existing.limit, options.limit);
    if (existing.count >= existing.limit) {
      throw new BackofficeApiError(
        429,
        "RATE_LIMITED",
        "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
      );
    }
    existing.count += 1;
    return;
  }
  if (existing !== undefined) buckets.delete(key);
  if (buckets.size >= maximumBuckets) {
    throw new BackofficeApiError(
      429,
      "RATE_LIMITED",
      "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    );
  }
  buckets.set(key, { count: 1, limit: options.limit, resetAt: now + options.windowMs });
}
