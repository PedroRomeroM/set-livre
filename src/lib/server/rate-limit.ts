import "server-only";

import { ApiRouteError } from "./api-route";

type Bucket = {
  count: number;
  key: string;
  limit: number;
  partition: string;
  resetAt: number;
};

type OverflowCounter = { count: number; limit: number; resetAt: number };

const EXACT_BUCKET_SWEEP_BUDGET = 8;
const MAXIMUM_OVERFLOW_PARTITIONS = 64;

export class BoundedFixedWindowRateLimiter {
  // Exact buckets are never evicted while live. Once exact storage is full, missing keys share a
  // bounded, sticky fixed-window counter for their server-controlled action partition.
  readonly #bucketsByPartition = new Map<string, Map<string, Bucket>>();
  readonly #exactBucketSweepOrder = new Map<Bucket, true>();
  readonly #maximumBuckets: number;
  readonly #maximumOverflowPartitions: number;
  readonly #overflowCountersByPartition = new Map<string, OverflowCounter>();
  #bucketCount = 0;

  constructor(maximumBuckets = 10_000) {
    if (!Number.isSafeInteger(maximumBuckets) || maximumBuckets <= 0) {
      throw new RangeError("maximumBuckets precisa ser um inteiro positivo.");
    }
    this.#maximumBuckets = maximumBuckets;
    this.#maximumOverflowPartitions = Math.min(maximumBuckets, MAXIMUM_OVERFLOW_PARTITIONS);
  }

  consume(partition: string, key: string, limit: number, windowMs: number, now = Date.now()) {
    this.#sweepExpiredExactBuckets(now);
    const current = this.#bucketsByPartition.get(partition)?.get(key);
    if (current !== undefined && current.resetAt > now) {
      return this.#consumeLiveBucket(current, limit);
    }

    if (current !== undefined) {
      this.#deleteExactBucket(current);
    }

    const overflow = this.#overflowCountersByPartition.get(partition);
    if (overflow !== undefined) {
      if (overflow.resetAt > now) {
        return this.#consumeLiveBucket(overflow, limit);
      }
      this.#overflowCountersByPartition.delete(partition);
    }

    if (this.#bucketCount >= this.#maximumBuckets) {
      return this.#consumeOverflow(partition, limit, windowMs, now);
    }

    let partitionBuckets = this.#bucketsByPartition.get(partition);
    if (partitionBuckets === undefined) {
      partitionBuckets = new Map<string, Bucket>();
      this.#bucketsByPartition.set(partition, partitionBuckets);
    }
    const bucket = { count: 1, key, limit, partition, resetAt: now + windowMs };
    partitionBuckets.set(key, bucket);
    this.#exactBucketSweepOrder.set(bucket, true);
    this.#bucketCount += 1;
    return true;
  }

  resetForTests() {
    this.#bucketsByPartition.clear();
    this.#exactBucketSweepOrder.clear();
    this.#overflowCountersByPartition.clear();
    this.#bucketCount = 0;
  }

  storageSizeForTests() {
    return {
      exactBuckets: this.#bucketCount,
      overflowCounters: this.#overflowCountersByPartition.size,
    } as const;
  }

  #consumeLiveBucket(bucket: Pick<Bucket, "count" | "limit">, requestedLimit: number) {
    bucket.limit = Math.min(bucket.limit, requestedLimit);
    if (bucket.count >= bucket.limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  #consumeOverflow(partition: string, limit: number, windowMs: number, now: number) {
    if (this.#overflowCountersByPartition.size >= this.#maximumOverflowPartitions) {
      this.#deleteExpiredOverflowCounters(now);
    }
    if (this.#overflowCountersByPartition.size >= this.#maximumOverflowPartitions) {
      return false;
    }
    this.#overflowCountersByPartition.set(partition, {
      count: 1,
      limit,
      resetAt: now + windowMs,
    });
    return true;
  }

  #deleteExactBucket(bucket: Bucket) {
    const partitionBuckets = this.#bucketsByPartition.get(bucket.partition);
    if (partitionBuckets?.get(bucket.key) !== bucket) {
      return;
    }
    partitionBuckets.delete(bucket.key);
    this.#exactBucketSweepOrder.delete(bucket);
    this.#bucketCount -= 1;
    if (partitionBuckets.size === 0) {
      this.#bucketsByPartition.delete(bucket.partition);
    }
  }

  #deleteExpiredOverflowCounters(now: number) {
    for (const [partition, counter] of this.#overflowCountersByPartition) {
      if (counter.resetAt <= now) {
        this.#overflowCountersByPartition.delete(partition);
      }
    }
  }

  #sweepExpiredExactBuckets(now: number) {
    const sweepCount = Math.min(EXACT_BUCKET_SWEEP_BUDGET, this.#exactBucketSweepOrder.size);
    for (let index = 0; index < sweepCount; index += 1) {
      const bucket = this.#exactBucketSweepOrder.keys().next().value;
      if (bucket === undefined) {
        throw new Error("O armazenamento do rate limiter perdeu a ordem de expiração.");
      }
      this.#exactBucketSweepOrder.delete(bucket);
      if (bucket.resetAt <= now) {
        this.#deleteExactBucket(bucket);
      } else {
        this.#exactBucketSweepOrder.set(bucket, true);
      }
    }
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
