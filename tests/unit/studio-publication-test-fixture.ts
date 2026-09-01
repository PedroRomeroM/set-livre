import { studioPublicationSchema, type StudioPublication } from "@set-livre/contracts";

import { studioTestIds } from "./studio-test-fixture";

const revision = {
  addressComplement: "Sala 2",
  amenities: [
    {
      active: true,
      id: studioTestIds.amenityId,
      name: "Wi-Fi",
      sortOrder: 10,
    },
  ],
  capacity: 12,
  city: "Curitiba",
  cover: {
    byteSize: 120_000,
    checksumSha256: "a".repeat(64),
    height: 900,
    id: "81000000-0000-4000-8000-000000000001",
    isCover: true,
    mimeType: "image/jpeg",
    position: 1,
    previewUrl:
      "https://example.supabase.co/storage/v1/object/sign/studio-media/cover.jpg?token=test",
    width: 1_200,
  },
  description: "Estúdio completo para fotografia, vídeo e podcast.",
  faqs: [
    {
      answer: "Consulte a agenda antes de reservar.",
      id: "82000000-0000-4000-8000-000000000001",
      position: 1,
      question: "Como consultar horários?",
    },
  ],
  id: studioTestIds.revisionId,
  mediaCount: 3,
  name: "Estúdio Aurora",
  neighborhood: "Centro",
  number: 1,
  postalCode: "80010000",
  state: "PR",
  status: "draft",
  street: "Rua das Flores",
  streetNumber: "100",
  studioType: {
    id: studioTestIds.studioTypeId,
    name: "Estúdio audiovisual",
  },
  tags: [
    {
      active: true,
      id: studioTestIds.tagId,
      name: "Podcast",
      sortOrder: 10,
    },
  ],
  usageRules: "Respeite o horário reservado e preserve os equipamentos.",
  version: 1,
  youtubeVideoId: "dQw4w9WgXcQ",
} as const;

export function createStudioPublicationFixture(
  overrides: Partial<StudioPublication> = {},
): StudioPublication {
  return studioPublicationSchema.parse({
    canPause: false,
    canResume: false,
    canSubmit: true,
    checklist: [
      { complete: true, key: "details", messages: [] },
      { complete: true, key: "content", messages: [] },
      { complete: true, key: "media", messages: [] },
    ],
    currentRevision: revision,
    latestReview: null,
    previewExpiresAt: "2026-08-31T20:05:00.000Z",
    publicationVersion: 1,
    publishedRevision: null,
    scope: studioTestIds.userId,
    studioId: studioTestIds.studioId,
    studioStatus: "draft",
    ...overrides,
  });
}
