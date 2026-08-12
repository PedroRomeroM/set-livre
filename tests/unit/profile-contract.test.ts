import { describe, expect, it } from "vitest";

import {
  additionalDocumentSchema,
  brazilianPhoneSchema,
  cnpjSchema,
  cpfSchema,
  formatBrazilianPhoneForDisplay,
  formatCnpjForDisplay,
  formatCpfForDisplay,
  identityCommandSchema,
  myProfileResultSchema,
  normalizeBrazilianPhone,
  normalizeCnpj,
  normalizeCpf,
  profileCompletePayloadSchema,
  profileIdentityUpdatePayloadSchema,
  profileUpdatePayloadSchema,
} from "../../packages/contracts/src";

describe("profile contracts", () => {
  function applyPhoneMaskSequence(value: string) {
    let displayed = "";
    for (const character of value) {
      displayed = formatBrazilianPhoneForDisplay(`${displayed}${character}`);
    }
    return displayed;
  }

  it("normalizes and validates a CPF without accepting repeated digits", () => {
    expect(cpfSchema.parse("529.982.247-25")).toBe("52998224725");
    expect(normalizeCpf(" 529.982.247-25 ")).toBe("52998224725");
    expect(formatCpfForDisplay("52998224725")).toBe("529.982.247-25");
    for (const invalid of ["529.982.247-24", "111.111.111-11", "529A98224725"]) {
      expect(cpfSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("supports numeric and official alphanumeric CNPJ with the same DV algorithm", () => {
    expect(cnpjSchema.parse("04.252.011/0001-10")).toBe("04252011000110");
    expect(cnpjSchema.parse("12.ABC.345/01DE-35")).toBe("12ABC34501DE35");
    expect(normalizeCnpj(" 12.abc.345/01de-35 ")).toBe("12ABC34501DE35");
    expect(formatCnpjForDisplay("04252011000110")).toBe("04.252.011/0001-10");
    expect(formatCnpjForDisplay("12abc34501de35")).toBe("12.ABC.345/01DE-35");
    for (const invalid of ["12.ABC.345/01DE-34", "AAAAAAAAAAAA00", "12.ABC.345/01DE-AA"]) {
      expect(cnpjSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("normalizes Brazilian mobile and landline phones", () => {
    expect(brazilianPhoneSchema.parse("(41) 99999-1234")).toBe("+5541999991234");
    expect(brazilianPhoneSchema.parse("+55 (41) 3333-1234")).toBe("+554133331234");
    expect(brazilianPhoneSchema.parse("55 41 3333-1234")).toBe("+554133331234");
    expect(brazilianPhoneSchema.parse("(55) 3333-1234")).toBe("+555533331234");
    expect(brazilianPhoneSchema.safeParse("41 19999-1234").success).toBe(false);
  });

  it("does not infer a country code from excess digits or truncate an invalid prefix", () => {
    const invalidPrefix = "994133331234";
    const displayed = formatBrazilianPhoneForDisplay(invalidPrefix);
    const foreignDisplayed = formatBrazilianPhoneForDisplay("+54 (41) 3333-1234");
    const shortForeignDisplayed = formatBrazilianPhoneForDisplay("+54 9 2222-2222");
    const payload = {
      additionalDocument: null,
      expectedProfileVersion: 0,
      name: "Pessoa Exemplo",
      personType: "individual",
      phone: displayed,
      taxId: "529.982.247-25",
    } as const;

    expect(displayed).toBe("(99) 41333-31234");
    expect(displayed.replace(/\D/gu, "")).toBe(invalidPrefix);
    expect(normalizeBrazilianPhone(displayed)).toBe("+55994133331234");
    expect(brazilianPhoneSchema.safeParse(displayed).success).toBe(false);
    expect(foreignDisplayed).toBe("+544133331234");
    expect(foreignDisplayed.replace(/\D/gu, "")).toBe("544133331234");
    expect(brazilianPhoneSchema.safeParse(foreignDisplayed).success).toBe(false);
    expect(shortForeignDisplayed).toBe("+54922222222");
    expect(normalizeBrazilianPhone(shortForeignDisplayed)).toBe("+54922222222");
    expect(brazilianPhoneSchema.safeParse(shortForeignDisplayed).success).toBe(false);
    expect(profileCompletePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("formats national and explicit +55 or 55 phone inputs without losing digits", () => {
    expect(formatBrazilianPhoneForDisplay("41999991234")).toBe("(41) 99999-1234");
    expect(formatBrazilianPhoneForDisplay("+554133331234")).toBe("+55 (41) 3333-1234");
    expect(formatBrazilianPhoneForDisplay("554133331234")).toBe("+55 (41) 3333-1234");
    expect(formatBrazilianPhoneForDisplay("5533331234")).toBe("(55) 3333-1234");
    expect(applyPhoneMaskSequence("41999991234")).toBe("(41) 99999-1234");
    expect(applyPhoneMaskSequence("+554133331234")).toBe("+55 (41) 3333-1234");
    expect(applyPhoneMaskSequence("554133331234")).toBe("+55 (41) 3333-1234");
    expect(applyPhoneMaskSequence("994133331234")).toBe("(99) 41333-31234");
    expect(applyPhoneMaskSequence("+54922222222")).toBe("+54922222222");
  });

  it("keeps unsupported phone characters visible so validation cannot sanitize them", () => {
    const invalidMobile = "+55 (41) A9999-1234";
    const wouldBecomeValidIfSanitized = "+55 (41) A3333-1234";

    expect(formatBrazilianPhoneForDisplay(invalidMobile)).toBe(invalidMobile);
    expect(formatBrazilianPhoneForDisplay(wouldBecomeValidIfSanitized)).toBe(
      wouldBecomeValidIfSanitized,
    );
    expect(normalizeBrazilianPhone(wouldBecomeValidIfSanitized)).toBe(wouldBecomeValidIfSanitized);
    expect(brazilianPhoneSchema.safeParse(invalidMobile).success).toBe(false);
    expect(brazilianPhoneSchema.safeParse(wouldBecomeValidIfSanitized).success).toBe(false);
  });

  it("preserves masked excess so complete and update payloads reject it", () => {
    const longPhone = formatBrazilianPhoneForDisplay("+55 (41) 99999-12345");
    const foreignPhone = formatBrazilianPhoneForDisplay("+54 9 2222-2222");
    const invalidCharacterPhone = formatBrazilianPhoneForDisplay("+55 (41) A3333-1234");
    const longCpf = formatCpfForDisplay("529.982.247-250");
    const longCnpj = formatCnpjForDisplay("04.252.011/0001-100");
    const alphanumericCnpjDv = formatCnpjForDisplay("04.252.011/0001-1A");
    const commonCompletion = {
      additionalDocument: null,
      expectedProfileVersion: 0,
      name: "Pessoa Exemplo",
      phone: "(41) 99999-1234",
    } as const;
    const commonUpdate = {
      documentChange: { action: "keep" as const },
      expectedProfileVersion: 1,
      name: "Pessoa Exemplo",
      phone: "(41) 99999-1234",
      section: "identity" as const,
      taxIdChange: { action: "keep" as const },
    };

    expect(longPhone).toBe("+55 (41) 99999-12345");
    expect(longPhone.replace(/\D/gu, "")).toBe("55419999912345");
    expect(longCpf).toBe("529.982.247-250");
    expect(longCnpj).toBe("04.252.011/0001-100");
    expect(alphanumericCnpjDv).toBe("04.252.011/0001-1A");
    expect(normalizeCpf(longCpf)).toBe("529982247250");
    expect(normalizeCnpj(longCnpj)).toBe("042520110001100");
    expect(normalizeCnpj(alphanumericCnpjDv)).toBe("0425201100011A");

    for (const invalidPhone of [longPhone, foreignPhone, invalidCharacterPhone]) {
      expect(
        profileCompletePayloadSchema.safeParse({
          ...commonCompletion,
          personType: "individual",
          phone: invalidPhone,
          taxId: "529.982.247-25",
        }).success,
      ).toBe(false);
      expect(
        profileIdentityUpdatePayloadSchema.safeParse({
          ...commonUpdate,
          phone: invalidPhone,
        }).success,
      ).toBe(false);
    }

    for (const invalidTaxId of [longCpf, longCnpj, alphanumericCnpjDv]) {
      expect(
        profileIdentityUpdatePayloadSchema.safeParse({
          ...commonUpdate,
          taxIdChange: { action: "replace", value: invalidTaxId },
        }).success,
      ).toBe(false);
    }
    expect(
      profileCompletePayloadSchema.safeParse({
        ...commonCompletion,
        personType: "individual",
        taxId: longCpf,
      }).success,
    ).toBe(false);
    for (const taxId of [longCnpj, alphanumericCnpjDv]) {
      expect(
        profileCompletePayloadSchema.safeParse({
          ...commonCompletion,
          name: "Empresa Exemplo",
          personType: "company",
          taxId,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps the optional document opaque, bounded and free of controls", () => {
    expect(additionalDocumentSchema.parse("  rg 12.345-6 ")).toBe("RG 12.345-6");
    expect(additionalDocumentSchema.safeParse("AB").success).toBe(false);
    expect(additionalDocumentSchema.parse("RG  123")).toBe("RG 123");
    for (const invalid of ["RG:<script>", ".RG123", "RG//123"]) {
      expect(additionalDocumentSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires a strict SSR scope assertion and rejects status or userId as authority", () => {
    const expectedScope = "11111111-1111-4111-8111-111111111111";
    const payload = {
      additionalDocument: "RG 12.345-6",
      expectedProfileVersion: 0,
      name: "  Pessoa   Exemplo ",
      personType: "individual",
      phone: "(41) 99999-1234",
      taxId: "529.982.247-25",
    } as const;
    expect(profileCompletePayloadSchema.parse(payload)).toMatchObject({
      name: "Pessoa Exemplo",
      phone: "+5541999991234",
      taxId: "52998224725",
    });
    expect(
      identityCommandSchema.parse({
        action: "profile.complete",
        expectedScope,
        payload,
      }),
    ).toMatchObject({ action: "profile.complete", expectedScope });
    expect(identityCommandSchema.safeParse({ action: "profile.complete", payload }).success).toBe(
      false,
    );
    expect(
      identityCommandSchema.safeParse({
        action: "profile.complete",
        expectedScope,
        payload: { ...payload, status: "active" },
      }).success,
    ).toBe(false);
    expect(
      identityCommandSchema.safeParse({
        action: "profile.complete",
        expectedScope,
        payload: { ...payload, userId: "11111111-1111-4111-8111-111111111111" },
      }).success,
    ).toBe(false);
    expect(
      identityCommandSchema.safeParse({
        action: "profile.complete",
        expectedScope,
        payload,
        userId: expectedScope,
      }).success,
    ).toBe(false);
  });

  it("requires explicit keep, replace or clear semantics on profile updates", () => {
    const identityUpdate = {
      documentChange: { action: "clear" },
      expectedProfileVersion: 1,
      name: "Pessoa Exemplo",
      phone: "+55 41 99999-1234",
      section: "identity",
      taxIdChange: { action: "keep" },
    } as const;
    expect(profileUpdatePayloadSchema.parse(identityUpdate)).toMatchObject({
      documentChange: { action: "clear" },
      taxIdChange: { action: "keep" },
    });
    expect(
      profileUpdatePayloadSchema.safeParse({ ...identityUpdate, personType: "company" }).success,
    ).toBe(false);
    expect(
      profileUpdatePayloadSchema.safeParse({
        colorScheme: "dark",
        expectedPreferencesVersion: Number.MAX_SAFE_INTEGER + 1,
        section: "appearance",
      }).success,
    ).toBe(false);
    expect(
      profileUpdatePayloadSchema.safeParse({
        colorScheme: "dark",
        expectedPreferencesVersion: 0,
        section: "appearance",
      }).success,
    ).toBe(true);
  });

  it("accepts only masked documents in the private profile DTO", () => {
    const dto = {
      profile: {
        additionalDocumentMasked: "*********-6",
        colorScheme: "system",
        completed: true,
        name: "Pessoa Exemplo",
        personType: "individual",
        phone: "+5541999991234",
        preferencesVersion: 0,
        profileVersion: 1,
        status: "active",
        taxIdMasked: "***.***.***-25",
      },
      scope: "11111111-1111-4111-8111-111111111111",
    } as const;
    expect(myProfileResultSchema.parse(dto)).toEqual(dto);
    expect(
      myProfileResultSchema.safeParse({
        ...dto,
        profile: { ...dto.profile, taxId: "52998224725" },
      }).success,
    ).toBe(false);
    expect(
      myProfileResultSchema.safeParse({
        ...dto,
        profile: { ...dto.profile, taxIdMasked: "52998224725" },
      }).success,
    ).toBe(false);
    expect(
      myProfileResultSchema.safeParse({
        ...dto,
        profile: { ...dto.profile, additionalDocumentMasked: "RG 12.345-6" },
      }).success,
    ).toBe(false);
  });
});
