import { describe, expect, it } from "vitest";

import { createBackofficeContentSecurityPolicy } from "../../apps/backoffice/src/lib/content-security-policy";

const nonce = "0123456789abcdef0123456789abcdef";

function directives(policy: string) {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values] as const;
    }),
  );
}

describe("backoffice Content Security Policy", () => {
  it("publishes the validated Supabase origin only as an image source", () => {
    const policy = directives(
      createBackofficeContentSecurityPolicy(nonce, false, "https://project-ref.supabase.co"),
    );

    expect(policy.get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://project-ref.supabase.co",
    ]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
  });
});
