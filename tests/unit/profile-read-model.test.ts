import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn(), rpc: vi.fn() }));
const client = {
  rpc: mocks.rpc,
};

vi.mock("../../src/lib/supabase/server", () => ({
  createComponentSupabaseClient: async () => client,
}));

import {
  mapMyProfileRow,
  mapOwnProfileRow,
  readOwnProfile,
} from "../../src/domains/identity/server/profile-read-model";

const userId = "11111111-1111-4111-8111-111111111111";

describe("profile read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockReturnValue({ maybeSingle: mocks.maybeSingle });
  });

  it("maps a complete row without any raw document field", () => {
    const result = mapMyProfileRow({
      additional_document_masked: "*********-6",
      color_scheme: "light",
      name: "Pessoa Exemplo",
      person_type: "individual",
      phone_e164: "+5541999991234",
      preferences_version: 2,
      profile_completed: true,
      profile_version: 3,
      status: "active",
      tax_id_masked: "***.***.***-25",
      user_id: userId,
    });

    expect(result).toEqual({
      profile: {
        additionalDocumentMasked: "*********-6",
        colorScheme: "light",
        completed: true,
        name: "Pessoa Exemplo",
        personType: "individual",
        phone: "+5541999991234",
        preferencesVersion: 2,
        profileVersion: 3,
        status: "active",
        taxIdMasked: "***.***.***-25",
      },
      scope: userId,
    });
    expect(JSON.stringify(result)).not.toContain("52998224725");
  });

  it("rejects partial personal data on an incomplete profile", () => {
    expect(() =>
      mapMyProfileRow({
        additional_document_masked: null,
        color_scheme: "system",
        name: "Dados parciais",
        person_type: "company",
        phone_e164: null,
        preferences_version: 0,
        profile_completed: false,
        profile_version: 0,
        status: "active",
        tax_id_masked: null,
        user_id: userId,
      }),
    ).toThrow();
  });

  it("rejects a valid masked row from another authenticated scope", () => {
    expect(() =>
      mapOwnProfileRow(
        {
          additional_document_masked: null,
          color_scheme: "system",
          name: null,
          person_type: "individual",
          phone_e164: null,
          preferences_version: 0,
          profile_completed: false,
          profile_version: 0,
          status: "active",
          tax_id_masked: null,
          user_id: "22222222-2222-4222-8222-222222222222",
        },
        userId,
      ),
    ).toThrow("O perfil retornado não corresponde à sessão autenticada.");
  });

  it("reads through the authenticated security-invoker RPC without a user argument", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        additional_document_masked: null,
        color_scheme: "system",
        name: null,
        person_type: "individual",
        phone_e164: null,
        preferences_version: 0,
        profile_completed: false,
        profile_version: 0,
        status: "active",
        tax_id_masked: null,
        user_id: userId,
      },
      error: null,
    });

    await expect(readOwnProfile(userId)).resolves.toMatchObject({ scope: userId });
    expect(mocks.rpc).toHaveBeenCalledWith("get_my_profile");
  });

  it("fails closed when the authenticated RPC errors or returns no row", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { code: "unexpected" } });
    await expect(readOwnProfile(userId)).rejects.toThrow(
      "Não foi possível carregar o perfil autenticado.",
    );

    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(readOwnProfile(userId)).rejects.toThrow();
  });
});
