const backofficeAuthWindowMs = 15 * 60_000;

export function backofficeAuthNetworkRateLimitOptions(environment = process.env.APP_ENV) {
  return {
    limit: environment === "test" ? 10_000 : 30,
    windowMs: backofficeAuthWindowMs,
  } as const;
}
