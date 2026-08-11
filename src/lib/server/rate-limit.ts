import "server-only";

import { ApiRouteError } from "./api-route";

type Bucket = { count: number; resetAt: number };

export class BoundedFixedWindowRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maximumBuckets: number;

  constructor(maximumBuckets = 10_000) {
    this.#maximumBuckets = maximumBuckets;
  }

  consume(key: string, limit: number, windowMs: number, now = Date.now()) {
    const current = this.#buckets.get(key);
    if (current !== undefined && current.resetAt > now) {
      if (current.count >= limit) {
        return false;
      }
      current.count += 1;
      return true;
    }

    if (current !== undefined) {
      this.#buckets.delete(key);
    }
    if (this.#buckets.size >= this.#maximumBuckets) {
      for (const [candidateKey, candidate] of this.#buckets) {
        if (candidate.resetAt <= now) {
          this.#buckets.delete(candidateKey);
        }
      }
    }
    if (this.#buckets.size >= this.#maximumBuckets) {
      return false;
    }

    this.#buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  resetForTests() {
    this.#buckets.clear();
  }
}

const identityLimiter = new BoundedFixedWindowRateLimiter();

export function enforceIdentityRateLimit(
  action: string,
  privateDiscriminator: string,
  options: Readonly<{ limit: number; windowMs: number }>,
) {
  if (
    !identityLimiter.consume(`${action}:${privateDiscriminator}`, options.limit, options.windowMs)
  ) {
    throw new ApiRouteError(
      429,
      "RATE_LIMITED",
      "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    );
  }
}

export function resetIdentityRateLimitForTests() {
  identityLimiter.resetForTests();
}
