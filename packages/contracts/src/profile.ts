import { z } from "zod";

const forbiddenTextCharacters = /[\p{Cc}\p{Cf}]/u;
const cpfFormattingCharacters = /[.\-\s]/gu;
const cnpjFormattingCharacters = /[.\/\-\s]/gu;
const phoneNonDigits = /\D/gu;
const phoneAllowedCharactersPattern = /^[0-9()+\-\s]+$/u;
const cnpjCanonicalPattern = /^[A-Z0-9]{12}[0-9]{2}$/u;
const cpfCanonicalPattern = /^[0-9]{11}$/u;

function normalizeWhitespace(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function normalizeCpf(value: string) {
  return value.trim().replace(cpfFormattingCharacters, "");
}

export function normalizeCnpj(value: string) {
  return value.normalize("NFKC").trim().toUpperCase().replace(cnpjFormattingCharacters, "");
}

export function formatCpfForDisplay(value: string) {
  const characters = normalizeCpf(value);
  if (characters.length <= 3) return characters;
  if (characters.length <= 6) return `${characters.slice(0, 3)}.${characters.slice(3)}`;
  if (characters.length <= 9) {
    return `${characters.slice(0, 3)}.${characters.slice(3, 6)}.${characters.slice(6)}`;
  }
  return `${characters.slice(0, 3)}.${characters.slice(3, 6)}.${characters.slice(6, 9)}-${characters.slice(9)}`;
}

export function formatCnpjForDisplay(value: string) {
  const characters = normalizeCnpj(value);
  if (characters.length <= 2) return characters;
  if (characters.length <= 5) return `${characters.slice(0, 2)}.${characters.slice(2)}`;
  if (characters.length <= 8) {
    return `${characters.slice(0, 2)}.${characters.slice(2, 5)}.${characters.slice(5)}`;
  }
  if (characters.length <= 12) {
    return `${characters.slice(0, 2)}.${characters.slice(2, 5)}.${characters.slice(5, 8)}/${characters.slice(8)}`;
  }
  return `${characters.slice(0, 2)}.${characters.slice(2, 5)}.${characters.slice(5, 8)}/${characters.slice(8, 12)}-${characters.slice(12)}`;
}

function repeatedCharacters(value: string) {
  return new Set(value).size === 1;
}

function cpfDigit(base: string, factor: number) {
  let total = 0;
  for (const character of base) {
    total += Number(character) * factor;
    factor -= 1;
  }
  const remainder = (total * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

export function isValidCpf(value: string) {
  const canonical = normalizeCpf(value);
  if (!cpfCanonicalPattern.test(canonical) || repeatedCharacters(canonical)) {
    return false;
  }
  const base = canonical.slice(0, 9);
  const first = cpfDigit(base, 10);
  const second = cpfDigit(`${base}${first}`, 11);
  return canonical === `${base}${first}${second}`;
}

function cnpjCharacterValue(character: string) {
  return character.codePointAt(0)! - 48;
}

function cnpjDigit(base: string, weights: readonly number[]) {
  const total = [...base].reduce(
    (sum, character, index) => sum + cnpjCharacterValue(character) * (weights[index] ?? 0),
    0,
  );
  const remainder = total % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCnpj(value: string) {
  const canonical = normalizeCnpj(value);
  if (!cnpjCanonicalPattern.test(canonical) || repeatedCharacters(canonical.slice(0, 12))) {
    return false;
  }
  const base = canonical.slice(0, 12);
  const first = cnpjDigit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = cnpjDigit(`${base}${first}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return canonical === `${base}${first}${second}`;
}

function splitBrazilianPhone(value: string) {
  const trimmed = value.trim();
  const digits = value.replace(phoneNonDigits, "");
  const plusCount = [...value].filter((character) => character === "+").length;
  const hasSingleLeadingPlus = plusCount === 1 && trimmed.startsWith("+");
  const hasBrazilianCountryCode = hasSingleLeadingPlus && trimmed.startsWith("+55");
  const hasForeignCountryCode = hasSingleLeadingPlus && !hasBrazilianCountryCode;
  const hasUnsupportedPlus = plusCount > 0 && !hasSingleLeadingPlus;
  const hasBareBrazilianCountryCode =
    plusCount === 0 && digits.startsWith("55") && (digits.length === 12 || digits.length === 13);
  const hasCountryCode = hasBrazilianCountryCode || hasBareBrazilianCountryCode;
  return {
    digits,
    hasForeignCountryCode,
    hasCountryCode,
    hasUnsupportedCharacters: value !== "" && !phoneAllowedCharactersPattern.test(value),
    hasUnsupportedPlus,
    national: hasCountryCode ? digits.slice(2) : digits,
  } as const;
}

export function normalizeBrazilianPhone(value: string) {
  const { digits, hasForeignCountryCode, hasUnsupportedCharacters, hasUnsupportedPlus, national } =
    splitBrazilianPhone(value);
  if (hasUnsupportedCharacters || hasUnsupportedPlus) return value.trim();
  if (hasForeignCountryCode) return `+${digits}`;
  return `+55${national}`;
}

export function formatBrazilianPhoneForDisplay(value: string) {
  const {
    digits,
    hasCountryCode,
    hasForeignCountryCode,
    hasUnsupportedCharacters,
    hasUnsupportedPlus,
    national,
  } = splitBrazilianPhone(value);
  if (hasUnsupportedCharacters || hasUnsupportedPlus) return value;
  if (hasForeignCountryCode) return `+${digits}`;
  const areaCode = national.slice(0, 2);
  const local = national.slice(2);
  const prefix = hasCountryCode ? "+55 " : "";
  if (areaCode.length < 2) return `${prefix}${areaCode}`;
  if (local.length === 0) return `${prefix}(${areaCode})`;
  const split = local.length > 8 ? 5 : 4;
  const first = local.slice(0, split);
  const second = local.slice(split);
  return `${prefix}(${areaCode}) ${first}${second === "" ? "" : `-${second}`}`;
}

export const profileNameSchema = z
  .string()
  .transform(normalizeWhitespace)
  .pipe(
    z
      .string()
      .min(2, "Informe pelo menos 2 caracteres.")
      .max(160, "Use no máximo 160 caracteres.")
      .refine(
        (value) => !forbiddenTextCharacters.test(value),
        "O nome contém caracteres inválidos.",
      ),
  );

export const cpfSchema = z
  .string()
  .transform(normalizeCpf)
  .pipe(
    z
      .string()
      .regex(cpfCanonicalPattern, "Informe um CPF com 11 dígitos.")
      .refine(isValidCpf, "Informe um CPF válido."),
  );

export const cnpjSchema = z
  .string()
  .transform(normalizeCnpj)
  .pipe(
    z
      .string()
      .regex(
        cnpjCanonicalPattern,
        "Informe um CNPJ com 12 letras ou números e 2 dígitos verificadores.",
      )
      .refine(isValidCnpj, "Informe um CNPJ válido."),
  );

export const profileTaxIdSchema = z.union([cpfSchema, cnpjSchema]);

export const brazilianPhoneSchema = z
  .string()
  .regex(phoneAllowedCharactersPattern, "Informe um telefone brasileiro válido.")
  .refine((value) => {
    const { hasForeignCountryCode, hasUnsupportedPlus } = splitBrazilianPhone(value);
    return !hasForeignCountryCode && !hasUnsupportedPlus;
  }, "Informe um telefone brasileiro válido.")
  .transform(normalizeBrazilianPhone)
  .pipe(
    z
      .string()
      .regex(
        /^\+55[1-9][0-9](?:[2-5][0-9]{7}|9[0-9]{8})$/u,
        "Informe um telefone brasileiro válido.",
      ),
  );

export const additionalDocumentSchema = z
  .string()
  .transform((value) => normalizeWhitespace(value.normalize("NFKC")).toUpperCase())
  .pipe(
    z
      .string()
      .min(3, "Informe pelo menos 3 caracteres.")
      .max(40, "Use no máximo 40 caracteres.")
      .regex(/^[A-Z0-9]+(?:[./ -][A-Z0-9]+)*$/u, "O documento contém caracteres inválidos."),
  );

export const colorSchemePreferenceSchema = z.enum(["system", "light", "dark"]);
export const personTypeSchema = z.enum(["individual", "company"]);
export const profileVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const profileCompletionCommon = {
  additionalDocument: additionalDocumentSchema.nullable(),
  expectedProfileVersion: profileVersionSchema,
  name: profileNameSchema,
  phone: brazilianPhoneSchema,
} as const;

export const profileCompletePayloadSchema = z.discriminatedUnion("personType", [
  z.strictObject({
    ...profileCompletionCommon,
    personType: z.literal("individual"),
    taxId: cpfSchema,
  }),
  z.strictObject({
    ...profileCompletionCommon,
    personType: z.literal("company"),
    taxId: cnpjSchema,
  }),
]);

export const profileCompleteCommandSchema = z.strictObject({
  action: z.literal("profile.complete"),
  payload: profileCompletePayloadSchema,
});

export const profileTaxIdChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("replace"), value: profileTaxIdSchema }),
]);

export const profileDocumentChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("clear") }),
  z.strictObject({ action: z.literal("replace"), value: additionalDocumentSchema }),
]);

export const profileIdentityUpdatePayloadSchema = z.strictObject({
  documentChange: profileDocumentChangeSchema,
  expectedProfileVersion: profileVersionSchema,
  name: profileNameSchema,
  phone: brazilianPhoneSchema,
  section: z.literal("identity"),
  taxIdChange: profileTaxIdChangeSchema,
});

export const profileAppearanceUpdatePayloadSchema = z.strictObject({
  colorScheme: colorSchemePreferenceSchema,
  expectedPreferencesVersion: profileVersionSchema,
  section: z.literal("appearance"),
});

export const profileUpdatePayloadSchema = z.discriminatedUnion("section", [
  profileIdentityUpdatePayloadSchema,
  profileAppearanceUpdatePayloadSchema,
]);

export const profileUpdateCommandSchema = z.strictObject({
  action: z.literal("profile.update"),
  payload: profileUpdatePayloadSchema,
});

const profileSnapshotCommon = {
  colorScheme: colorSchemePreferenceSchema,
  preferencesVersion: profileVersionSchema,
  profileVersion: profileVersionSchema,
  status: z.enum(["active", "suspended"]),
} as const;

const additionalDocumentMaskSchema = z
  .string()
  .regex(/^\*{1,38}[A-Z0-9./ -]{2}$/u, "A máscara do documento adicional é inválida.");

export const profileSnapshotSchema = z.union([
  z.strictObject({
    ...profileSnapshotCommon,
    additionalDocumentMasked: z.null(),
    completed: z.literal(false),
    name: z.null(),
    personType: personTypeSchema,
    phone: z.null(),
    taxIdMasked: z.null(),
  }),
  z.strictObject({
    ...profileSnapshotCommon,
    additionalDocumentMasked: additionalDocumentMaskSchema.nullable(),
    completed: z.literal(true),
    name: profileNameSchema,
    personType: z.literal("individual"),
    phone: brazilianPhoneSchema,
    taxIdMasked: z.string().regex(/^\*{3}\.\*{3}\.\*{3}-[0-9]{2}$/u),
  }),
  z.strictObject({
    ...profileSnapshotCommon,
    additionalDocumentMasked: additionalDocumentMaskSchema.nullable(),
    completed: z.literal(true),
    name: profileNameSchema,
    personType: z.literal("company"),
    phone: brazilianPhoneSchema,
    taxIdMasked: z.string().regex(/^\*{2}\.\*{3}\.\*{3}\/\*{4}-[0-9]{2}$/u),
  }),
]);

export const myProfileResultSchema = z.strictObject({
  profile: profileSnapshotSchema,
  scope: z.uuid(),
});

export type ColorSchemePreference = z.infer<typeof colorSchemePreferenceSchema>;
export type MyProfileResult = z.infer<typeof myProfileResultSchema>;
export type PersonType = z.infer<typeof personTypeSchema>;
export type ProfileCompletePayload = z.infer<typeof profileCompletePayloadSchema>;
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>;
export type ProfileUpdatePayload = z.infer<typeof profileUpdatePayloadSchema>;
