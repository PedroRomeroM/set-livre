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
    expect(policy.get("frame-src")).toEqual(["https://www.youtube-nocookie.com"]);
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

  it("admits only the exact Supabase image origin required by signed private previews", () => {
    const production = directives(
      createContentSecurityPolicy(nonce, false, {
        imageOrigins: ["https://project.supabase.co", "https://project.supabase.co"],
      }),
    );
    const local = directives(
      createContentSecurityPolicy(nonce, true, {
        imageOrigins: ["http://127.0.0.1:54321"],
      }),
    );

    expect(production.get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://project.supabase.co",
    ]);
    expect(local.get("img-src")).toEqual(["'self'", "data:", "blob:", "http://127.0.0.1:54321"]);
  });

  it.each([
    "http://project.supabase.co",
    "https://project.supabase.co/path",
    "https://project.supabase.co/",
    "https://user:secret@project.supabase.co",
    "https://project.supabase.co; script-src *",
    "http://192.168.0.2:54321",
  ])("rejects a broad, injected or non-canonical image origin", (candidate) => {
    expect(() => createContentSecurityPolicy(nonce, false, { imageOrigins: [candidate] })).toThrow(
      "origem de imagem da Content Security Policy é inválida",
    );
  });

  it("rejects loopback HTTP outside development", () => {
    expect(() =>
      createContentSecurityPolicy(nonce, false, {
        imageOrigins: ["http://127.0.0.1:54321"],
      }),
    ).toThrow("origem de imagem da Content Security Policy é inválida");
  });

  it("allows test-mode loopback without enabling development script evaluation", () => {
    const policy = directives(
      createContentSecurityPolicy(nonce, false, {
        allowLoopbackHttpImageOrigins: true,
        imageOrigins: ["http://127.0.0.1:54321"],
      }),
    );

    expect(policy.get("img-src")).toContain("http://127.0.0.1:54321");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
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
