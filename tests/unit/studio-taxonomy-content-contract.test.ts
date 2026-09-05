import { describe, expect, it } from "vitest";

import {
  parseStudioYoutubeVideoId,
  studioContentPayloadSchema,
  studioRevisionUpdateContentCommandSchema,
  studioTaxonomiesSchema,
  studioTaxonomyPayloadSchema,
  studioTypeOptionsSchema,
  studioYoutubeVideoInputSchema,
} from "@set-livre/contracts";
import { studioTestIds } from "./studio-test-fixture";

describe("studio taxonomy and content contracts", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=12", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["   ", null],
  ])("normalizes an allowed YouTube input %s", (input, expected) => {
    expect(parseStudioYoutubeVideoId(input)).toBe(expected);
    expect(studioYoutubeVideoInputSchema.parse(input)).toBe(expected);
  });

  it.each([
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://user:password@www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ/extra",
    "javascript:alert(1)",
  ])("rejects a YouTube input outside the host and path allowlist", (input) => {
    expect(parseStudioYoutubeVideoId(input)).toBeUndefined();
    expect(studioYoutubeVideoInputSchema.safeParse(input).success).toBe(false);
  });

  it("limits and deduplicates tags and amenities", () => {
    expect(
      studioTaxonomyPayloadSchema.safeParse({
        amenityIds: [studioTestIds.amenityId],
        tagIds: [studioTestIds.tagId, studioTestIds.tagId],
      }).success,
    ).toBe(false);
    expect(
      studioTaxonomyPayloadSchema.safeParse({
        amenityIds: [],
        tagIds: Array.from(
          { length: 21 },
          (_, index) => `62000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("does not impose an arbitrary parser cap on administrated option catalogs", () => {
    const options = Array.from({ length: 101 }, (_, index) => ({
      id: `62000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `Opção ${index + 1}`,
      sortOrder: index + 1,
    }));
    expect(studioTaxonomiesSchema.safeParse({ amenities: options, tags: options }).success).toBe(
      true,
    );
    expect(studioTypeOptionsSchema.safeParse(options).success).toBe(true);
  });

  it("trims plain text and enforces FAQ and rules limits", () => {
    expect(
      studioContentPayloadSchema.parse({
        faqs: [{ answer: "  Resposta segura.  ", question: "  Pergunta segura?  " }],
        usageRules: "  Preserve os equipamentos.  ",
        youtubeVideoId: "dQw4w9WgXcQ",
      }),
    ).toEqual({
      faqs: [{ answer: "Resposta segura.", question: "Pergunta segura?" }],
      usageRules: "Preserve os equipamentos.",
      youtubeVideoId: "dQw4w9WgXcQ",
    });
    expect(
      studioContentPayloadSchema.safeParse({
        faqs: Array.from({ length: 21 }, () => ({ answer: "A", question: "Q" })),
        usageRules: "",
        youtubeVideoId: null,
      }).success,
    ).toBe(false);
    expect(
      studioContentPayloadSchema.safeParse({
        faqs: [{ answer: "A", question: "Q".repeat(161) }],
        usageRules: "R".repeat(5001),
        youtubeVideoId: null,
      }).success,
    ).toBe(false);
  });

  it("keeps the private content command strict and revision-fenced", () => {
    const command = {
      action: "studio.revision.updateContent",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 3,
        faqs: [],
        studioId: studioTestIds.studioId,
        usageRules: "",
        youtubeVideoId: null,
      },
    } as const;
    expect(studioRevisionUpdateContentCommandSchema.parse(command)).toEqual(command);
    expect(
      studioRevisionUpdateContentCommandSchema.safeParse({ ...command, status: "approved" })
        .success,
    ).toBe(false);
  });
});
