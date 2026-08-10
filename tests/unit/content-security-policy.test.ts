import { describe, expect, it } from "vitest";

import { createContentSecurityPolicy } from "@set-livre/contracts/content-security-policy";

const nonce = "0123456789abcdef0123456789abcdef";

function directives(policy: string) {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values] as const;
    }),
  );
}

describe("Content Security Policy nonce contract", () => {
  it("allows only nonce-authorized script bootstrap in production", () => {
    const policy = directives(createContentSecurityPolicy(nonce, false));

    expect(policy.get("script-src")).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
  });

  it("adds only the development sources required by the local Next runtime", () => {
    const policy = directives(createContentSecurityPolicy(nonce, true));

    expect(policy.get("script-src")).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "'unsafe-eval'",
    ]);
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(policy.get("connect-src")).toEqual(["'self'", "http://127.0.0.1:*", "ws://127.0.0.1:*"]);
  });

  it.each([
    "",
    "too-short",
    "0123456789abcdef0123456789abcdeF",
    "0123456789abcdef0123456789abcde'",
    "0123456789abcdef0123456789abcdef; script-src *",
  ])("rejects a nonce outside the generated hexadecimal contract", (candidate) => {
    expect(() => createContentSecurityPolicy(candidate, false)).toThrow(
      "nonce da Content Security Policy possui formato inválido",
    );
  });
});
