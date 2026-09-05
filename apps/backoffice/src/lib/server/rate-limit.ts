import "server-only";

import type { BackofficeCommand } from "@set-livre/contracts";

import { BackofficeApiError, hashBackofficePrivateValue } from "./api-route";

type Bucket = { count: number; limit: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const maximumBuckets = 2_000;
const sweepBudget = 16;
const identityActionProfile = { limit: 30, windowMs: 60_000 } as const;
const destructiveIdentityProfile = { limit: 20, windowMs: 60 * 60_000 } as const;

const destructiveBackofficeActions = {
  "backoffice.access.grantAdmin": false,
  "backoffice.access.grantReviewer": false,
  "backoffice.access.grantSupport": false,
  "backoffice.access.revokeAdmin": true,
  "backoffice.access.revokeReviewer": true,
  "backoffice.access.revokeSupport": true,
  "backoffice.studio.approve": false,
  "backoffice.studio.disable": true,
  "backoffice.studio.reject": false,
  "backoffice.studio.restore": false,
  "backoffice.taxonomy.archive": true,
  "backoffice.taxonomy.reactivate": false,
  "backoffice.taxonomy.upsert": false,
  "backoffice.user.restore": false,
  "backoffice.user.revealPii": false,
  "backoffice.user.suspend": true,
} as const satisfies Readonly<Record<BackofficeCommand["action"], boolean>>;

function backofficeIdentityDiscriminator(scope: string) {
  return hashBackofficePrivateValue(scope);
}

export function backofficeIdentityActionDiscriminator(scope: string, action: string) {
  return hashBackofficePrivateValue(JSON.stringify([scope, action]));
}

function sweepExpired(now: number) {
  const sweepCount = Math.min(sweepBudget, buckets.size);
  for (let inspected = 0; inspected < sweepCount; inspected += 1) {
    const entry = buckets.entries().next().value;
    if (entry === undefined) {
      throw new Error("O armazenamento do rate limiter perdeu sua ordem de varredura.");
    }
    const [key, bucket] = entry;
    buckets.delete(key);
    if (bucket.resetAt > now) buckets.set(key, bucket);
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

export function enforceBackofficeCommandIdentityRateLimits(
  scope: string,
  action: BackofficeCommand["action"],
) {
  enforceBackofficeRateLimit(
    "backoffice.commands.identity-action",
    backofficeIdentityActionDiscriminator(scope, action),
    identityActionProfile,
  );
  if (destructiveBackofficeActions[action]) {
    enforceBackofficeRateLimit(
      "backoffice.commands.identity-destructive",
      backofficeIdentityDiscriminator(scope),
      destructiveIdentityProfile,
    );
  }
}
