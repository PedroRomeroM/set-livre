import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  completeMyProfile: vi.fn(),
  enforceIdentityRateLimit: vi.fn(),
  updateMyProfileAppearance: vi.fn(),
  updateMyProfileIdentity: vi.fn(),
  writeProfilePreferenceCookie: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));

vi.mock("@/lib/server/rate-limit", () => ({
  enforceIdentityRateLimit: mocks.enforceIdentityRateLimit,
}));

vi.mock("../../src/domains/identity/server/profile-dal", () => ({
  completeMyProfile: mocks.completeMyProfile,
  updateMyProfileAppearance: mocks.updateMyProfileAppearance,
  updateMyProfileIdentity: mocks.updateMyProfileIdentity,
}));

vi.mock("../../src/domains/identity/server/profile-preference-cookie", () => ({
  writeProfilePreferenceCookie: mocks.writeProfilePreferenceCookie,
}));

import { completeProfile, updateProfile } from "../../src/domains/identity/server/profile-service";

const userId = "11111111-1111-4111-8111-111111111111";
const session = {
  authenticated: true as const,
  email: "qa-profile@example.test",
  personType: "individual" as const,
  profileCompleted: false,
  status: "active" as const,
  userId,
};
const row = {
  additional_document_masked: null,
  color_scheme: "system",
  name: "Pessoa Exemplo",
  person_type: "individual",
  phone_e164: "+5541999991234",
  preferences_version: 0,
  profile_completed: true,
  profile_version: 1,
  status: "active",
  tax_id_masked: "***.***.***-25",
  user_id: userId,
};

describe("profile service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completeMyProfile.mockResolvedValue(row);
    mocks.updateMyProfileIdentity.mockResolvedValue(row);
    mocks.updateMyProfileAppearance.mockResolvedValue(row);
  });

  it("completes only the authenticated user's own profile", async () => {
    const result = await completeProfile(
      {
        additionalDocument: null,
        expectedProfileVersion: 0,
        name: "Pessoa Exemplo",
        personType: "individual",
        phone: "+5541999991234",
        taxId: "52998224725",
      },
      session,
    );
    expect(mocks.completeMyProfile).toHaveBeenCalledWith(userId, expect.any(Object));
    expect(mocks.writeProfilePreferenceCookie).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scope: userId, profile: { completed: true } });
  });

  it("blocks a suspended account before touching the DAL", async () => {
    await expect(
      completeProfile(
        {
          additionalDocument: null,
          expectedProfileVersion: 0,
          name: "Pessoa Exemplo",
          personType: "individual",
          phone: "+5541999991234",
          taxId: "52998224725",
        },
        { ...session, status: "suspended" },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED", status: 403 });
    expect(mocks.completeMyProfile).not.toHaveBeenCalled();
  });

  it("rejects a tax identifier inconsistent with the immutable person type", async () => {
    await expect(
      updateProfile(
        {
          documentChange: { action: "keep" },
          expectedProfileVersion: 1,
          name: "Pessoa Exemplo",
          phone: "+5541999991234",
          section: "identity",
          taxIdChange: { action: "replace", value: "12ABC34501DE35" },
        },
        session,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: { taxId: "Informe um CPF válido." },
      status: 422,
    });
    expect(mocks.updateMyProfileIdentity).not.toHaveBeenCalled();
  });

  it("rejects a masked mutation result from another user before projecting preference", async () => {
    mocks.updateMyProfileAppearance.mockResolvedValueOnce({
      ...row,
      user_id: "22222222-2222-4222-8222-222222222222",
    });

    await expect(
      updateProfile(
        {
          colorScheme: "dark",
          expectedPreferencesVersion: 0,
          section: "appearance",
        },
        session,
      ),
    ).rejects.toThrow("O perfil retornado não corresponde à sessão autenticada.");
    expect(mocks.writeProfilePreferenceCookie).not.toHaveBeenCalled();
  });

  it.each([
    ["40001", "CONFLICT", 409],
    ["42501", "ACCOUNT_SUSPENDED", 403],
    ["22023", "VALIDATION_FAILED", 422],
  ] as const)("maps database code %s to %s", async (databaseCode, publicCode, status) => {
    mocks.updateMyProfileAppearance.mockRejectedValueOnce({
      code: databaseCode,
      detail: "private profile value",
    });
    const outcome = updateProfile(
      {
        colorScheme: "dark",
        expectedPreferencesVersion: 0,
        section: "appearance",
      },
      session,
    ).catch((error: unknown) => error);
    await expect(outcome).resolves.toMatchObject({ code: publicCode, status });
    expect(JSON.stringify(await outcome)).not.toContain("private profile value");
  });

  it("projects an authoritative appearance update to the presentation cookie", async () => {
    mocks.updateMyProfileAppearance.mockResolvedValueOnce({ ...row, color_scheme: "dark" });

    await expect(
      updateProfile(
        {
          colorScheme: "dark",
          expectedPreferencesVersion: 0,
          section: "appearance",
        },
        session,
      ),
    ).resolves.toMatchObject({ profile: { colorScheme: "dark" } });
    expect(mocks.writeProfilePreferenceCookie).toHaveBeenCalledWith({}, "dark");
  });
});
