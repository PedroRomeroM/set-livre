const backofficeLoginWindowMs = 15 * 60_000;

export function backofficeLoginNetworkRateLimitOptions(environment = process.env.APP_ENV) {
  return {
    limit: environment === "test" ? 10_000 : 30,
    windowMs: backofficeLoginWindowMs,
  } as const;
}
