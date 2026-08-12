import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/lib/server/dal-pool", () => ({
  commandDalPool: () => ({ query: mocks.query }),
}));

import {
  activateOwnerProfile,
  applyOwnerRecipientOperation,
  getOwnerRecipientStatusForUser,
  mapOwnerActivationDalRow,
  mapOwnerRecipientStatusDalRow,
  parseOwnerActivationDalRow,
  parseOwnerRecipientStatusDalRow,
  prepareOwnerRecipientOperation,
} from "../../src/domains/owners/server/owner-dal";

const userId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const contractId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const row = {
  accepted_owner_contract_version_id: null,
  next_action: "activate_owner",
  owner_contract_accepted: false,
  owner_contract_body_markdown: "# Contrato local",
  owner_contract_content_hash: "a".repeat(64),
  owner_contract_effective_at: "2026-08-12T00:00:00.000Z",
  owner_contract_id: contractId,
  owner_contract_kind: "owner_contract",
  owner_contract_source: "local_fixture",
  owner_contract_title: "Contrato do dono",
  owner_contract_version: "local-1",
  owner_status: "inactive",
  owner_version: "0",
  profile_version: "4",
  profile_version_synced: null,
  provider_mode: "local",
  recipient_status: "not_started",
  recipient_version: "0",
  requirements: [],
  reservations_eligible: false,
  scope: userId,
};
const recipientRow = {
  accepted_owner_contract_version_id: row.accepted_owner_contract_version_id,
  next_action: row.next_action,
  owner_contract_accepted: row.owner_contract_accepted,
  owner_contract_effective_at: row.owner_contract_effective_at,
  owner_contract_id: row.owner_contract_id,
  owner_contract_source: row.owner_contract_source,
  owner_status: row.owner_status,
  owner_version: row.owner_version,
  profile_version: row.profile_version,
  profile_version_synced: row.profile_version_synced,
  provider_mode: row.provider_mode,
  recipient_status: row.recipient_status,
  recipient_version: row.recipient_version,
  requirements: row.requirements,
  reservations_eligible: row.reservations_eligible,
  scope: row.scope,
};

describe("owner DAL", () => {
  beforeEach(() => {
    process.env.APP_ENV = "test";
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [row] });
  });

  it("calls the exact private read and activation signatures", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [recipientRow] });
    await getOwnerRecipientStatusForUser(userId);
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.get_owner_recipient_status_for_user($1::uuid)"),
      [userId],
    );
    expect(mocks.query.mock.calls[0]?.[0]).not.toContain("owner_contract_body_markdown");

    const userAgentHash = "b".repeat(64);
    await activateOwnerProfile({
      idempotencyKey,
      ownerContractVersionId: contractId,
      userAgentHash,
      userId,
    });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.activate_owner"),
      [userId, contractId, idempotencyKey, userAgentHash],
    );
  });

  it("prepares with action/key and maps the private operation without provider calls", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          already_applied: false,
          operation_action: "refresh",
          operation_id: operationId,
          operation_sequence: "2",
          profile_version: "4",
          provider_reference: "private-reference",
        },
      ],
    });
    await expect(
      prepareOwnerRecipientOperation({
        action: "recipient.onboarding.refresh",
        idempotencyKey,
        userId,
      }),
    ).resolves.toEqual({
      alreadyApplied: false,
      operation: "refresh",
      operationId,
      operationSequence: 2,
      profileVersion: 4,
      providerReference: "private-reference",
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("private.prepare_owner_recipient_operation"),
      [userId, "refresh", idempotencyKey],
    );
  });

  it("applies only the mapped provider snapshot to the exact conditional apply signature", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          ...recipientRow,
          next_action: "refresh_status",
          owner_contract_accepted: true,
          accepted_owner_contract_version_id: contractId,
          owner_status: "active",
          owner_version: "1",
          profile_version_synced: "4",
          recipient_status: "pending",
          recipient_version: "1",
          requirements: ["identity_review"],
        },
      ],
    });
    await applyOwnerRecipientOperation({
      operationId,
      provider: "local",
      providerReference: "private-reference",
      requirements: ["identity_review"],
      status: "pending",
      userId,
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("private.apply_owner_recipient_operation"),
      [userId, operationId, "local", "private-reference", "pending", ["identity_review"]],
    );
    expect(mocks.query.mock.calls.at(-1)?.[0]).not.toContain("owner_contract_body_markdown");
  });

  it("maps strict full/slim rows and rejects scope/provider/column drift", () => {
    const parsedRecipientRow = parseOwnerRecipientStatusDalRow(recipientRow);
    expect(mapOwnerRecipientStatusDalRow(parsedRecipientRow, userId)).toMatchObject({
      nextAction: "activate_owner",
      ownerVersion: 0,
      profileVersion: 4,
      projection: "recipient",
      providerMode: "local",
      scope: userId,
    });
    expect(() =>
      mapOwnerRecipientStatusDalRow(parsedRecipientRow, "55555555-5555-4555-8555-555555555555"),
    ).toThrow("não corresponde");
    expect(mapOwnerActivationDalRow(parseOwnerActivationDalRow(row), userId)).toMatchObject({
      ownerContract: { bodyMarkdown: row.owner_contract_body_markdown },
      projection: "activation",
    });
    for (const malformed of [
      { ...recipientRow, provider_mode: "pagarme" },
      { ...recipientRow, provider_reference: "private" },
      { ...recipientRow, owner_contract_body_markdown: "# unexpected" },
      { ...recipientRow, owner_version: "01" },
      { ...recipientRow, owner_contract_effective_at: "12/08/2026" },
    ]) {
      expect(() => parseOwnerRecipientStatusDalRow(malformed)).toThrow();
    }
    expect(() => parseOwnerActivationDalRow({ ...row, owner_contract_kind: "terms" })).toThrow();
  });

  it("fails closed on zero or multiple command rows", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(getOwnerRecipientStatusForUser(userId)).rejects.toThrow("cardinalidade");
    mocks.query.mockResolvedValueOnce({ rows: [recipientRow, recipientRow] });
    await expect(getOwnerRecipientStatusForUser(userId)).rejects.toThrow("cardinalidade");
  });

  it("refuses a local fixture DTO outside local/test while allowing an approved contract", () => {
    process.env.APP_ENV = "production";
    const parsedRow = parseOwnerRecipientStatusDalRow(recipientRow);
    expect(() => mapOwnerRecipientStatusDalRow(parsedRow, userId)).toThrow("proibido");
    expect(() =>
      mapOwnerRecipientStatusDalRow(
        parseOwnerRecipientStatusDalRow({
          ...recipientRow,
          owner_contract_source: "approved",
        }),
        userId,
      ),
    ).not.toThrow();
  });
});
