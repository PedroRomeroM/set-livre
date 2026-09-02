import { createContentSecurityPolicy } from "@set-livre/contracts/content-security-policy";

export function createBackofficeContentSecurityPolicy(
  nonce: string,
  isDevelopment: boolean,
  supabaseOrigin: string,
) {
  const allowLoopbackSupabaseOrigin = new URL(supabaseOrigin).protocol === "http:";

  return createContentSecurityPolicy(nonce, isDevelopment, {
    allowLoopbackHttpImageOrigins: allowLoopbackSupabaseOrigin,
    imageOrigins: [supabaseOrigin],
  });
}
