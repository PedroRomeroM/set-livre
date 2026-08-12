import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ poolOn: vi.fn(), query: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class Pool {
    on = mocks.poolOn;
    query = mocks.query;
  },
}));

import {
  completeMyProfile,
  updateMyProfileAppearance,
  updateMyProfileIdentity,
} from "../../src/domains/identity/server/profile-dal";

const userId = "11111111-1111-4111-8111-111111111111";
const completeRow = {
  additional_document_masked: "*********-6",
  color_scheme: "system",
  name: "Pessoa Exemplo",
  person_type: "individual",
  phone_e164: "+5541999991234",
  preferences_version: "0",
  profile_completed: true,
  profile_version: "1",
  status: "active",
  tax_id_masked: "***.***.***-25",
  user_id: userId,
};

describe("profile DAL", () => {
  beforeAll(() => {
    process.env.DATABASE_URL_APP_DAL =
      "postgresql://app_runtime:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [completeRow] });
  });

  it("passes only normalized scalar values to profile completion", async () => {
    await completeMyProfile(userId, {
      additionalDocument: "RG 12.345-6",
      expectedProfileVersion: 0,
      name: "Pessoa Exemplo",
      personType: "individual",
      phone: "+5541999991234",
      taxId: "52998224725",
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("private.complete_profile"), [
      userId,
      0,
      "individual",
      "Pessoa Exemplo",
      "+5541999991234",
      "52998224725",
      "RG 12.345-6",
    ]);
  });

  it("maps keep, replace and clear to explicit SQL flags", async () => {
    await updateMyProfileIdentity(userId, {
      documentChange: { action: "clear" },
      expectedProfileVersion: 1,
      name: "Pessoa Exemplo",
      phone: "+5541999991234",
      section: "identity",
      taxIdChange: { action: "keep" },
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("private.update_profile_identity"),
      [userId, 1, "Pessoa Exemplo", "+5541999991234", false, null, true, null],
    );

    await updateMyProfileAppearance(userId, {
      colorScheme: "dark",
      expectedPreferencesVersion: 0,
      section: "appearance",
    });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.update_profile_appearance"),
      [userId, 0, "dark"],
    );
  });

  it("fails closed on malformed or ambiguous rows", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      completeMyProfile(userId, {
        additionalDocument: null,
        expectedProfileVersion: 0,
        name: "Pessoa Exemplo",
        personType: "individual",
        phone: "+5541999991234",
        taxId: "52998224725",
      }),
    ).rejects.toThrow("cardinalidade inesperada");

    mocks.query.mockResolvedValueOnce({ rows: [{ ...completeRow, tax_id: "52998224725" }] });
    await expect(
      completeMyProfile(userId, {
        additionalDocument: null,
        expectedProfileVersion: 0,
        name: "Pessoa Exemplo",
        personType: "individual",
        phone: "+5541999991234",
        taxId: "52998224725",
      }),
    ).rejects.toThrow();

    for (const malformedVersion of [null, "", "01", "9007199254740992"]) {
      mocks.query.mockResolvedValueOnce({
        rows: [{ ...completeRow, profile_version: malformedVersion }],
      });
      await expect(
        completeMyProfile(userId, {
          additionalDocument: null,
          expectedProfileVersion: 0,
          name: "Pessoa Exemplo",
          personType: "individual",
          phone: "+5541999991234",
          taxId: "52998224725",
        }),
      ).rejects.toThrow();
    }
  });
});
