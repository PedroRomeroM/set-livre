import { describe, expect, it } from "vitest";

import { readBackofficeSupabaseEnvironment } from "../../apps/backoffice/src/lib/supabase/config";

const productionEnvironment = {
  APP_ENV: "production",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_contract_key",
  NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
} as const;

describe("backoffice environment", () => {
  it("models the current production boundary as an SSH tunnel over loopback", () => {
    expect(readBackofficeSupabaseEnvironment(productionEnvironment)).toMatchObject({
      accessMode: "ssh-tunnel",
      appOrigin: "http://127.0.0.1:3001",
      cookieOptions: { secure: false },
      environment: "production",
    });
  });

  it("rejects non-TLS production origins outside the exact tunnel endpoint", () => {
    expect(() =>
      readBackofficeSupabaseEnvironment({
        ...productionEnvironment,
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3002",
      }),
    ).toThrow("túnel SSH");
    expect(() =>
      readBackofficeSupabaseEnvironment({
        ...productionEnvironment,
        NEXT_PUBLIC_APP_URL: "http://ops.setlivre.com",
      }),
    ).toThrow("túnel SSH");
  });

  it("keeps a future HTTPS reverse proxy in secure-cookie mode", () => {
    expect(
      readBackofficeSupabaseEnvironment({
        ...productionEnvironment,
        NEXT_PUBLIC_APP_URL: "https://ops.setlivre.com",
      }),
    ).toMatchObject({ accessMode: "reverse-proxy", cookieOptions: { secure: true } });
  });
});
