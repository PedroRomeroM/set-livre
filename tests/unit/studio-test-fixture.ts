import type { StudioCorePayload, StudioEditor, StudioTypeOption } from "@set-livre/contracts";

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
