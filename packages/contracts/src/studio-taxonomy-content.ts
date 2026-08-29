import { z } from "zod";

const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/u;
const youtubeHosts = new Set([
  "m.youtube.com",
  "www.youtube-nocookie.com",
  "www.youtube.com",
  "youtu.be",
  "youtube.com",
]);

function uniqueUuidList(label: string) {
  return z
    .array(z.uuid())
    .max(20, `Selecione no máximo 20 ${label}.`)
    .refine((values) => new Set(values).size === values.length, {
      message: `Não repita ${label} na seleção.`,
    });
}

function videoIdFromYoutubeUrl(url: URL) {
  if (url.protocol !== "https:" || !youtubeHosts.has(url.hostname.toLowerCase())) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;

  const hostname = url.hostname.toLowerCase();
  if (hostname === "youtu.be") {
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length === 1 ? segments[0] : undefined;
  }

  if (url.pathname === "/watch") return url.searchParams.get("v") ?? undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 2 && ["embed", "shorts"].includes(segments[0] ?? "")) {
    return segments[1];
  }
  return undefined;
}

export function parseStudioYoutubeVideoId(value: string): string | null | undefined {
  const normalized = value.trim();
  if (normalized === "") return null;
  if (youtubeVideoIdPattern.test(normalized)) return normalized;

  try {
    const videoId = videoIdFromYoutubeUrl(new URL(normalized));
    return videoId !== undefined && youtubeVideoIdPattern.test(videoId) ? videoId : undefined;
  } catch {
    return undefined;
  }
}

export const studioYoutubeVideoIdSchema = z
  .string()
  .regex(youtubeVideoIdPattern, "Informe um ID válido de vídeo do YouTube.");

export const studioYoutubeVideoInputSchema = z
  .string()
  .trim()
  .max(500, "A URL do YouTube é muito longa.")
  .transform((value, context) => {
    const videoId = parseStudioYoutubeVideoId(value);
    if (videoId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Use um ID ou uma URL HTTPS válida do YouTube.",
      });
      return z.NEVER;
    }
    return videoId;
  });

export const studioUsageRulesSchema = z
  .string()
  .trim()
  .max(5000, "Use no máximo 5.000 caracteres nas regras de uso.");

export const studioFaqInputSchema = z.strictObject({
  answer: z
    .string()
    .trim()
    .min(1, "Informe a resposta da FAQ.")
    .max(2000, "Use no máximo 2.000 caracteres na resposta."),
  question: z
    .string()
    .trim()
    .min(1, "Informe a pergunta da FAQ.")
    .max(160, "Use no máximo 160 caracteres na pergunta."),
});

export const studioFaqSchema = studioFaqInputSchema.extend({
  id: z.uuid(),
  position: z.number().int().min(1).max(20),
});

export const studioTaxonomyOptionSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(2).max(80),
  sortOrder: z.number().int().nonnegative(),
});

export const studioTaxonomyReferenceSchema = studioTaxonomyOptionSchema.extend({
  active: z.boolean(),
});

export const studioTaxonomiesSchema = z.strictObject({
  amenities: z.array(studioTaxonomyOptionSchema),
  tags: z.array(studioTaxonomyOptionSchema),
});

export const studioTaxonomyPayloadSchema = z.strictObject({
  amenityIds: uniqueUuidList("comodidades"),
  tagIds: uniqueUuidList("tags"),
});

export const studioContentPayloadSchema = z.strictObject({
  faqs: z.array(studioFaqInputSchema).max(20, "Cadastre no máximo 20 perguntas frequentes."),
  usageRules: studioUsageRulesSchema,
  youtubeVideoId: studioYoutubeVideoIdSchema.nullable(),
});

export type StudioContentPayload = z.infer<typeof studioContentPayloadSchema>;
export type StudioFaq = z.infer<typeof studioFaqSchema>;
export type StudioFaqInput = z.infer<typeof studioFaqInputSchema>;
export type StudioTaxonomies = z.infer<typeof studioTaxonomiesSchema>;
export type StudioTaxonomyOption = z.infer<typeof studioTaxonomyOptionSchema>;
export type StudioTaxonomyReference = z.infer<typeof studioTaxonomyReferenceSchema>;
export type StudioTaxonomyPayload = z.infer<typeof studioTaxonomyPayloadSchema>;
