import type {
  BackofficeStudioReviewDetail,
  BackofficeStudioReviewDetailRecord,
  StudioCorePayload,
  StudioEditor,
  StudioTypeOption,
} from "@set-livre/contracts";

export const studioTestIds = {
  amenityId: "63000000-0000-4000-8000-000000000001",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  otherStudioId: "77777777-7777-4777-8777-777777777777",
  otherUserId: "22222222-2222-4222-8222-222222222222",
  publishedRevisionId: "66666666-6666-4666-8666-666666666666",
  requestId: "44444444-4444-4444-8444-444444444444",
  revisionId: "55555555-5555-4555-8555-555555555555",
  studioId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  studioTypeId: "60000000-0000-4000-8000-000000000001",
  tagId: "62000000-0000-4000-8000-000000000001",
  userId: "11111111-1111-4111-8111-111111111111",
} as const;

export const backofficeStudioReviewTestIds = {
  faqId: "a1000000-0000-4000-8000-000000000004",
  mediaId: "a1000000-0000-4000-8000-000000000003",
  reviewerId: "a1000000-0000-4000-8000-000000000001",
} as const;

export const backofficeStudioReviewSubmittedAt = "2026-09-01T20:00:00.000Z";
export const backofficeStudioReviewPreviewPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${backofficeStudioReviewTestIds.mediaId}.preview.webp`;
const backofficeStudioReviewPreviewUrl =
  "https://project.supabase.co/storage/v1/object/sign/preview-a";

const studioReviewRevisionBase = {
  addressComplement: "Sala 2",
  amenities: [{ active: true, id: studioTestIds.amenityId, name: "Wi-Fi", sortOrder: 10 }],
  capacity: 12,
  city: "Curitiba" as const,
  description: "Estúdio completo para fotografia, vídeo e podcast.",
  faqs: [
    {
      answer: "Consulte a agenda antes de reservar.",
      id: backofficeStudioReviewTestIds.faqId,
      position: 1,
      question: "Como consultar horários?",
    },
  ],
  id: studioTestIds.revisionId,
  mediaCount: 1,
  name: "Estúdio Aurora",
  neighborhood: "Centro",
  number: 1,
  postalCode: "80010000",
  state: "PR" as const,
  status: "pending" as const,
  street: "Rua das Flores",
  streetNumber: "100",
  studioType: { id: studioTestIds.studioTypeId, name: "Estúdio audiovisual" },
  tags: [{ active: true, id: studioTestIds.tagId, name: "Podcast", sortOrder: 10 }],
  usageRules: "Respeite o horário reservado.",
  version: 4,
  youtubeVideoId: "dQw4w9WgXcQ",
};

type StudioReviewRecordRevision = BackofficeStudioReviewDetailRecord["candidateRevision"];
type StudioReviewRevision = BackofficeStudioReviewDetail["candidateRevision"];

export function studioReviewRevisionRecordFixture(
  overrides: Partial<StudioReviewRecordRevision> = {},
): StudioReviewRecordRevision {
  return {
    ...studioReviewRevisionBase,
    media: [
      {
        byteSize: 120_000,
        checksumSha256: "a".repeat(64),
        height: 900,
        id: backofficeStudioReviewTestIds.mediaId,
        isCover: true,
        mimeType: "image/jpeg",
        position: 1,
        previewStoragePath: backofficeStudioReviewPreviewPath,
        width: 1_200,
      },
    ],
    ...overrides,
  };
}

function studioReviewRevisionFixture(
  overrides: Partial<StudioReviewRevision> = {},
): StudioReviewRevision {
  return {
    ...studioReviewRevisionBase,
    media: [
      {
        byteSize: 120_000,
        checksumSha256: "a".repeat(64),
        height: 900,
        id: backofficeStudioReviewTestIds.mediaId,
        isCover: true,
        mimeType: "image/jpeg",
        position: 1,
        previewUrl: backofficeStudioReviewPreviewUrl,
        width: 1_200,
      },
    ],
    ...overrides,
  };
}

function studioReviewChecklist() {
  return [
    { complete: true, key: "details" as const, messages: [] },
    { complete: true, key: "content" as const, messages: [] },
    { complete: true, key: "media" as const, messages: [] },
  ];
}

export function backofficeStudioReviewDetailRecordFixture(
  overrides: Partial<BackofficeStudioReviewDetailRecord> = {},
): BackofficeStudioReviewDetailRecord {
  return {
    canApprove: true,
    canDisable: false,
    canReject: true,
    canRestore: false,
    candidateRevision: studioReviewRevisionRecordFixture(),
    checklist: studioReviewChecklist(),
    disabledFromStatus: null,
    previewExpiresAt: null,
    publicationVersion: 2,
    publishedRevision: null,
    reviewState: "reviewPending",
    scope: backofficeStudioReviewTestIds.reviewerId,
    studioId: studioTestIds.studioId,
    studioStatus: "pending_review",
    submittedAt: backofficeStudioReviewSubmittedAt,
    ...overrides,
  };
}

export function backofficeStudioReviewDetailFixture(
  overrides: Partial<BackofficeStudioReviewDetail> = {},
): BackofficeStudioReviewDetail {
  return {
    canApprove: true,
    canDisable: false,
    canReject: true,
    canRestore: false,
    candidateRevision: studioReviewRevisionFixture(),
    checklist: studioReviewChecklist(),
    disabledFromStatus: null,
    previewExpiresAt: "2026-09-01T20:05:00.000Z",
    publicationVersion: 2,
    publishedRevision: null,
    reviewState: "reviewPending",
    scope: backofficeStudioReviewTestIds.reviewerId,
    studioId: studioTestIds.studioId,
    studioStatus: "pending_review",
    submittedAt: backofficeStudioReviewSubmittedAt,
    ...overrides,
  };
}

export const studioCoreFixture = {
  addressComplement: null,
  capacity: 12,
  city: "Curitiba",
  description: "Estúdio completo para ensaios fotográficos e gravações audiovisuais.",
  name: "Estúdio Aurora",
  neighborhood: "Centro",
  postalCode: "80010000",
  state: "PR",
  street: "Rua das Flores",
  streetNumber: "100",
  studioTypeId: studioTestIds.studioTypeId,
} satisfies StudioCorePayload;

export const studioTypeFixture = {
  id: studioTestIds.studioTypeId,
  name: "Estúdio audiovisual",
  sortOrder: 10,
} satisfies StudioTypeOption;

export const studioEditorFixture = {
  draftRevisionId: studioTestIds.revisionId,
  hasDraft: true,
  publishedRevisionId: null,
  revision: {
    ...studioCoreFixture,
    amenities: [
      {
        active: true,
        id: studioTestIds.amenityId,
        name: "Wi-Fi",
        sortOrder: 10,
      },
    ],
    faqs: [
      {
        answer: "Use o formulário de reserva para consultar os horários disponíveis.",
        id: "99999999-9999-4999-8999-999999999999",
        position: 1,
        question: "Como consultar horários?",
      },
    ],
    id: studioTestIds.revisionId,
    number: 1,
    status: "draft",
    tags: [
      {
        active: true,
        id: studioTestIds.tagId,
        name: "Podcast",
        sortOrder: 10,
      },
    ],
    usageRules: "Respeite o horário reservado e preserve os equipamentos do espaço.",
    version: 1,
    youtubeVideoId: "dQw4w9WgXcQ",
  },
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
  studioStatus: "draft",
  studioType: {
    id: studioTypeFixture.id,
    name: studioTypeFixture.name,
  },
} satisfies StudioEditor;
