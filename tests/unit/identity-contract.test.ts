import { describe, expect, it } from "vitest";

import {
  apiErrorSchema,
  identityCallbackPayloadSchema,
  identityCommandSchema,
  identityEmailSchema,
  identityPasswordSchema,
  identityRegistrationFormSchema,
  resolveAuthenticatedReturnTo,
} from "../../packages/contracts/src";

const validRegistration = {
  acceptPrivacy: true,
  acceptTerms: true,
  email: "pessoa@example.test",
  password: "SenhaSegura1",
  personType: "individual",
  privacyVersionId: "b3e4eff5-aed0-4aa9-b6ff-5d2ecdf31cc7",
  termsVersionId: "ad964a04-1002-4d50-a240-61abf3b31e63",
} as const;

describe("identity contracts", () => {
  it("normalizes an e-mail without weakening validation", () => {
    expect(identityEmailSchema.parse("  PESSOA@EXAMPLE.TEST ")).toBe("pessoa@example.test");
    expect(identityEmailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it.each(["curta1A", "SENHASEGURA1", "senhasegura1", "SenhaSemNumero"])(
    "rejects a password outside the provider policy: %s",
    (password) => {
      expect(identityPasswordSchema.safeParse(password).success).toBe(false);
    },
  );

  it("accepts only the registered command and current legal versions", () => {
    expect(
      identityCommandSchema.parse({ action: "identity.register", payload: validRegistration }),
    ).toEqual({ action: "identity.register", payload: validRegistration });
    expect(
      identityCommandSchema.safeParse({
        action: "profile.complete",
        payload: validRegistration,
      }).success,
    ).toBe(false);
    expect(
      identityCommandSchema.safeParse({
        action: "identity.register",
        payload: { ...validRegistration, role: "admin" },
      }).success,
    ).toBe(false);
  });

  it("requires both legal acceptances and matching passwords", () => {
    expect(
      identityRegistrationFormSchema.safeParse({
        ...validRegistration,
        confirmPassword: validRegistration.password,
      }).success,
    ).toBe(true);
    expect(
      identityRegistrationFormSchema.safeParse({
        ...validRegistration,
        acceptPrivacy: false,
        confirmPassword: "OutraSenha1",
      }).success,
    ).toBe(false);
  });

  it.each([
    "https://attacker.example/account",
    "//attacker.example/account",
    "/conta?userId=11111111-1111-4111-8111-111111111111",
    "/entrar?sessao=ativa&next=https://attacker.example",
    "/entrar%3Fsessao%3Dativa",
    "\\\\attacker.example\\account",
    undefined,
  ])("fails closed for a non-allowlisted returnTo: %s", (candidate) => {
    expect(resolveAuthenticatedReturnTo(candidate)).toBe("/entrar?sessao=ativa");
  });

  it.each(["/entrar?sessao=ativa", "/conta", "/conta/seguranca"])(
    "preserves the exact authenticated surface: %s",
    (destination) => {
      expect(resolveAuthenticatedReturnTo(destination)).toBe(destination);
    },
  );

  it("limits callback types and token length", () => {
    const base = {
      tokenHash: "a".repeat(64),
      type: "recovery",
    };
    expect(identityCallbackPayloadSchema.safeParse(base).success).toBe(true);
    expect(identityCallbackPayloadSchema.safeParse({ ...base, type: "email" }).success).toBe(false);
    expect(identityCallbackPayloadSchema.safeParse({ ...base, type: "magiclink" }).success).toBe(
      false,
    );
  });

  it("keeps the public error envelope strict and free of technical fields", () => {
    const value = {
      error: {
        code: "INVALID_INPUT",
        fieldErrors: { email: "Informe um e-mail válido." },
        message: "Revise os campos destacados.",
        requestId: "e65fe64c-3788-4cf0-beb3-c344025b0bb0",
      },
    };

    expect(apiErrorSchema.parse(value)).toEqual(value);
    expect(
      apiErrorSchema.safeParse({
        ...value,
        error: { ...value.error, stack: "sensitive stack" },
      }).success,
    ).toBe(false);
  });
});
