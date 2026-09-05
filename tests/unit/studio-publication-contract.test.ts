import {
  studioCommandSchema,
  studioPublicationRecordSchema,
  studioPublicationSchema,
} from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

import { studioEditorFixture, studioTestIds } from "./studio-test-fixture";

const revisionRecord = {
  addressComplement: studioEditorFixture.revision.addressComplement,
  amenities: studioEditorFixture.revision.amenities,
  capacity: studioEditorFixture.revision.capacity,
  city: studioEditorFixture.revision.city,
  cover: null,
  description: studioEditorFixture.revision.description,
  faqs: studioEditorFixture.revision.faqs,
  id: studioEditorFixture.revision.id,
  mediaCount: 0,
  name: studioEditorFixture.revision.name,
  neighborhood: studioEditorFixture.revision.neighborhood,
  number: studioEditorFixture.revision.number,
  postalCode: studioEditorFixture.revision.postalCode,
  state: studioEditorFixture.revision.state,
  status: studioEditorFixture.revision.status,
  street: studioEditorFixture.revision.street,
  streetNumber: studioEditorFixture.revision.streetNumber,
  studioType: studioEditorFixture.studioType,
  tags: studioEditorFixture.revision.tags,
  usageRules: studioEditorFixture.revision.usageRules,
  version: studioEditorFixture.revision.version,
  youtubeVideoId: studioEditorFixture.revision.youtubeVideoId,
} as const;

const publicationRecord = {
  canPause: false,
  canResume: false,
  canSubmit: false,
  checklist: [
    { complete: true, key: "details", messages: [] },
    { complete: true, key: "content", messages: [] },
    {
      complete: false,
      key: "media",
      messages: ["Adicione ao menos uma foto.", "Escolha uma foto de capa."],
    },
  ],
  currentRevision: revisionRecord,
  latestReview: null,
  publicationVersion: 1,
  publishedRevision: null,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
  studioStatus: "draft",
} as const;

const completeChecklist = publicationRecord.checklist.map((item) => ({
  ...item,
  complete: true,
  messages: [],
}));
const approvedRevision = {
  ...revisionRecord,
  id: "77777777-7777-4777-8777-777777777777",
  number: 1,
  status: "approved",
} as const;

describe("studio publication contracts", () => {
  it("accepts the private record and rejects incomplete checklist ambiguity", () => {
    expect(studioPublicationRecordSchema.parse(publicationRecord)).toEqual(publicationRecord);
    expect(
      studioPublicationRecordSchema.safeParse({
        ...publicationRecord,
        checklist: publicationRecord.checklist.map((item) =>
          item.key === "media" ? { ...item, complete: true } : item,
        ),
      }).success,
    ).toBe(false);
    expect(
      studioPublicationRecordSchema.safeParse({
        ...publicationRecord,
        checklist: [
          publicationRecord.checklist[0],
          publicationRecord.checklist[0],
          publicationRecord.checklist[2],
        ],
      }).success,
    ).toBe(false);
  });

  it("requires an expiry exactly when a signed cover is returned", () => {
    const browserState = { ...publicationRecord, previewExpiresAt: null };
    expect(studioPublicationSchema.parse(browserState)).toEqual(browserState);
    expect(
      studioPublicationSchema.safeParse({
        ...browserState,
        currentRevision: {
          ...browserState.currentRevision,
          cover: {
            byteSize: 100,
            checksumSha256: "a".repeat(64),
            height: 720,
            id: "88888888-8888-4888-8888-888888888888",
            isCover: true,
            mimeType: "image/jpeg",
            position: 1,
            previewUrl: "https://storage.example.test/signed-cover",
            width: 1280,
          },
          mediaCount: 1,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only canonical publication state and revision graphs", () => {
    const validStates = [
      {
        label: "draft completo",
        state: {
          ...publicationRecord,
          canSubmit: true,
          checklist: completeChecklist,
        },
      },
      {
        label: "primeira revisão pendente",
        state: {
          ...publicationRecord,
          currentRevision: { ...revisionRecord, status: "pending" },
          studioStatus: "pending_review",
        },
      },
      {
        label: "publicado sem candidata",
        state: {
          ...publicationRecord,
          canPause: true,
          currentRevision: approvedRevision,
          publishedRevision: approvedRevision,
          studioStatus: "published",
        },
      },
      {
        label: "publicado com draft privado",
        state: {
          ...publicationRecord,
          canPause: true,
          canSubmit: true,
          checklist: completeChecklist,
          publishedRevision: approvedRevision,
          studioStatus: "changes_pending",
        },
      },
      {
        label: "retomado como publicado com draft privado",
        state: {
          ...publicationRecord,
          canPause: true,
          canSubmit: true,
          checklist: completeChecklist,
          publishedRevision: approvedRevision,
          studioStatus: "published",
        },
      },
      {
        label: "pausado com candidata pendente",
        state: {
          ...publicationRecord,
          canResume: true,
          currentRevision: { ...revisionRecord, status: "pending" },
          publishedRevision: approvedRevision,
          studioStatus: "paused",
        },
      },
      {
        label: "primeira revisão rejeitada",
        state: {
          ...publicationRecord,
          currentRevision: { ...revisionRecord, status: "rejected" },
          studioStatus: "rejected",
        },
      },
      {
        label: "bloqueio administrativo factual",
        state: {
          ...publicationRecord,
          studioStatus: "disabled",
        },
      },
    ];
    for (const { label, state } of validStates) {
      expect(studioPublicationRecordSchema.safeParse(state).success, label).toBe(true);
    }

    const impossibleStates = [
      { ...publicationRecord, studioStatus: "pending_review" },
      {
        ...publicationRecord,
        currentRevision: { ...revisionRecord, status: "pending" },
      },
      {
        ...publicationRecord,
        canPause: true,
        currentRevision: { ...revisionRecord, status: "pending" },
        publishedRevision: approvedRevision,
        studioStatus: "published",
      },
      {
        ...publicationRecord,
        canPause: true,
        currentRevision: approvedRevision,
        publishedRevision: approvedRevision,
        studioStatus: "changes_pending",
      },
      { ...publicationRecord, studioStatus: "paused" },
      {
        ...publicationRecord,
        publishedRevision: approvedRevision,
        studioStatus: "rejected",
      },
      { ...publicationRecord, canSubmit: true, studioStatus: "disabled" },
    ];
    for (const state of impossibleStates) {
      expect(studioPublicationRecordSchema.safeParse(state).success).toBe(false);
    }
  });

  it("keeps submit, pause and resume envelopes strict and version-fenced", () => {
    const envelope = {
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
    } as const;
    const submit = {
      action: "studio.revision.submit",
      ...envelope,
      payload: {
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 1,
        studioId: studioTestIds.studioId,
      },
    } as const;
    expect(studioCommandSchema.parse(submit)).toEqual(submit);
    for (const action of ["studio.pause", "studio.resume"] as const) {
      const command = {
        action,
        ...envelope,
        payload: { expectedPublicationVersion: 2, studioId: studioTestIds.studioId },
      };
      expect(studioCommandSchema.parse(command)).toEqual(command);
      expect(
        studioCommandSchema.safeParse({
          ...command,
          payload: { ...command.payload, expectedPublicationVersion: 0 },
        }).success,
      ).toBe(false);
    }
    expect(
      studioCommandSchema.safeParse({
        ...submit,
        payload: { ...submit.payload, studioStatus: "draft" },
      }).success,
    ).toBe(false);
  });
});
