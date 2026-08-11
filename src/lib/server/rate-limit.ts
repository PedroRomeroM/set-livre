import "server-only";

import { ApiRouteError } from "./api-route";

type Bucket = { count: number; resetAt: number };

export class BoundedFixedWindowRateLimiter {
  readonly #bucketsByPartition = new Map<string, Map<string, Bucket>>();
  readonly #maximumBuckets: number;
  #bucketCount = 0;

  constructor(maximumBuckets = 10_000) {
    if (!Number.isSafeInteger(maximumBuckets) || maximumBuckets <= 0) {
      throw new RangeError("maximumBuckets precisa ser um inteiro positivo.");
    }
    this.#maximumBuckets = maximumBuckets;
  }

  consume(partition: string, key: string, limit: number, windowMs: number, now = Date.now()) {
    const current = this.#bucketsByPartition.get(partition)?.get(key);
    if (current !== undefined && current.resetAt > now) {
      if (current.count >= limit) {
        return false;
      }
      current.count += 1;
      return true;
    }

    if (current !== undefined) {
      this.#deleteBucket(partition, key);
    }
    if (this.#bucketCount >= this.#maximumBuckets) {
      this.#evictAdmissionCandidate(partition);
    }

    let partitionBuckets = this.#bucketsByPartition.get(partition);
    if (partitionBuckets === undefined) {
      partitionBuckets = new Map<string, Bucket>();
      this.#bucketsByPartition.set(partition, partitionBuckets);
    }
    partitionBuckets.set(key, { count: 1, resetAt: now + windowMs });
    this.#bucketCount += 1;
    return true;
  }

  resetForTests() {
    this.#bucketsByPartition.clear();
    this.#bucketCount = 0;
  }

  #deleteBucket(partition: string, key: string) {
    const partitionBuckets = this.#bucketsByPartition.get(partition);
    if (partitionBuckets === undefined || !partitionBuckets.delete(key)) {
      return;
    }
    this.#bucketCount -= 1;
    if (partitionBuckets.size === 0) {
      this.#bucketsByPartition.delete(partition);
    }
  }

  #evictAdmissionCandidate(requestedPartition: string) {
    const requestedBuckets = this.#bucketsByPartition.get(requestedPartition);
    let largestPartition: string | undefined;
    let largestBuckets: Map<string, Bucket> | undefined;
    for (const [partition, buckets] of this.#bucketsByPartition) {
      if (largestBuckets === undefined || buckets.size > largestBuckets.size) {
        largestPartition = partition;
        largestBuckets = buckets;
      }
    }
    if (largestPartition === undefined || largestBuckets === undefined) {
      throw new Error("O armazenamento do rate limiter perdeu a contagem interna.");
    }
    if (requestedBuckets !== undefined && requestedBuckets.size >= largestBuckets.size) {
      this.#deleteOldestBucket(requestedPartition, requestedBuckets);
      return;
    }
    this.#deleteOldestBucket(largestPartition, largestBuckets);
  }

  #deleteOldestBucket(partition: string, buckets: Map<string, Bucket>) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) {
      throw new Error("Uma partição vazia permaneceu no armazenamento do rate limiter.");
    }
    this.#deleteBucket(partition, oldestKey);
  }
}

const identityLimiter = new BoundedFixedWindowRateLimiter();

export function enforceIdentityRateLimit(
  action: string,
  privateDiscriminator: string,
  options: Readonly<{ limit: number; windowMs: number }>,
) {
  if (!identityLimiter.consume(action, privateDiscriminator, options.limit, options.windowMs)) {
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
