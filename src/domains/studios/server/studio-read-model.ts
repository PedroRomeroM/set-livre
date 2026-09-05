import "server-only";

import {
  studioEditorSchema,
  studioFaqSchema,
  studioTaxonomyReferenceSchema,
  studioTaxonomiesSchema,
  studioTypeOptionsSchema,
  type StudioEditor,
  type StudioTaxonomies,
  type StudioTypeOption,
} from "@set-livre/contracts";
import { z } from "zod";

import { createComponentSupabaseClient } from "@/lib/supabase/server";

const studioReadDeadlineMs = 2_000;
const databasePositiveIntegerSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(z.number().int().positive()),
]);

const studioEditorRowSchema = z.strictObject({
  address_complement: z.string().nullable(),
  amenities: z.array(studioTaxonomyReferenceSchema).max(20),
  capacity: z.number().int(),
  city: z.string(),
  description: z.string(),
  draft_revision_id: z.uuid().nullable(),
  faqs: z.array(studioFaqSchema).max(20),
  has_draft: z.boolean(),
  name: z.string(),
  neighborhood: z.string(),
  postal_code: z.string(),
  published_revision_id: z.uuid().nullable(),
  revision_id: z.uuid(),
  revision_number: databasePositiveIntegerSchema,
  revision_status: z.string(),
  revision_version: databasePositiveIntegerSchema,
  scope: z.uuid(),
  state: z.string(),
  street: z.string(),
  street_number: z.string(),
  studio_id: z.uuid(),
  studio_status: z.string(),
  studio_type_id: z.uuid(),
  studio_type_name: z.string(),
  tags: z.array(studioTaxonomyReferenceSchema).max(20),
  usage_rules: z.string(),
  youtube_video_id: z.string().nullable(),
});

const studioTypeRowSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  sort_order: z.number().int().nonnegative(),
});

type ComponentSupabaseClient = Awaited<ReturnType<typeof createComponentSupabaseClient>>;

export class StudioNotFoundError extends Error {
  constructor() {
    super("O estúdio solicitado não foi encontrado para a sessão atual.");
    this.name = "StudioNotFoundError";
  }
}

function mapStudioEditorRow(
  row: unknown,
  expectedUserId: string,
  expectedStudioId: string,
): StudioEditor {
  const parsed = studioEditorRowSchema.parse(row);
  const editor = studioEditorSchema.parse({
    draftRevisionId: parsed.draft_revision_id,
    hasDraft: parsed.has_draft,
    publishedRevisionId: parsed.published_revision_id,
    revision: {
      addressComplement: parsed.address_complement,
      amenities: parsed.amenities,
      capacity: parsed.capacity,
      city: parsed.city,
      description: parsed.description,
      faqs: parsed.faqs,
      id: parsed.revision_id,
      name: parsed.name,
      neighborhood: parsed.neighborhood,
      number: parsed.revision_number,
      postalCode: parsed.postal_code,
      state: parsed.state,
      status: parsed.revision_status,
      street: parsed.street,
      streetNumber: parsed.street_number,
      studioTypeId: parsed.studio_type_id,
      tags: parsed.tags,
      usageRules: parsed.usage_rules,
      version: parsed.revision_version,
      youtubeVideoId: parsed.youtube_video_id,
    },
    scope: parsed.scope,
    studioId: parsed.studio_id,
    studioStatus: parsed.studio_status,
    studioType: { id: parsed.studio_type_id, name: parsed.studio_type_name },
  });
  if (editor.scope !== expectedUserId) {
    throw new Error("O editor de estúdio retornou um escopo diferente da sessão.");
  }
  if (editor.studioId !== expectedStudioId) {
    throw new Error("O editor de estúdio retornou um estúdio diferente do solicitado.");
  }
  return editor;
}

function mapStudioTypeRows(rows: unknown): StudioTypeOption[] {
  return studioTypeOptionsSchema.parse(
    z
      .array(studioTypeRowSchema)
      .parse(rows)
      .map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sort_order,
      })),
  );
}

async function withReadDeadline<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortError = new DOMException("A leitura de estúdio expirou.", "AbortError");
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortError), { once: true });
  });
  const abortFromExternal = () => controller.abort();
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    if (externalSignal?.aborted === true) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    deadline = setTimeout(() => controller.abort(), studioReadDeadlineMs);
    return await Promise.race([execute(controller.signal), abortOutcome]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

export async function readOwnerStudioEditorWithClient(
  client: ComponentSupabaseClient,
  userId: string,
  studioId: string,
  signal?: AbortSignal,
) {
  const parsedUserId = z.uuid().parse(userId);
  const parsedStudioId = z.uuid().parse(studioId).toLowerCase();
  return withReadDeadline(async (deadlineSignal) => {
    const { data, error } = await client
      .rpc("get_owner_studio_editor", { p_studio_id: parsedStudioId })
      .abortSignal(deadlineSignal)
      .maybeSingle();
    if (error !== null) {
      throw new Error("Não foi possível carregar o editor de estúdio autenticado.");
    }
    if (data === null) throw new StudioNotFoundError();
    return mapStudioEditorRow(data, parsedUserId, parsedStudioId);
  }, signal);
}

export async function readActiveStudioTypesWithClient(
  client: ComponentSupabaseClient,
  signal?: AbortSignal,
) {
  return withReadDeadline(async (deadlineSignal) => {
    const { data, error } = await client
      .rpc("list_active_studio_types")
      .abortSignal(deadlineSignal);
    if (error !== null || data === null) {
      throw new Error("Não foi possível carregar os tipos ativos de estúdio.");
    }
    return mapStudioTypeRows(data);
  }, signal);
}

export async function readActiveStudioTaxonomiesWithClient(
  client: ComponentSupabaseClient,
  signal?: AbortSignal,
): Promise<StudioTaxonomies> {
  return withReadDeadline(async (deadlineSignal) => {
    const { data, error } = await client
      .rpc("list_active_studio_taxonomies")
      .abortSignal(deadlineSignal)
      .maybeSingle();
    if (error !== null || data === null) {
      throw new Error("Não foi possível carregar as taxonomias ativas de estúdio.");
    }
    return studioTaxonomiesSchema.parse(data);
  }, signal);
}

export async function readOwnerStudioEditor(
  userId: string,
  studioId: string,
  signal?: AbortSignal,
) {
  return readOwnerStudioEditorWithClient(
    await createComponentSupabaseClient(),
    userId,
    studioId,
    signal,
  );
}

export async function readActiveStudioTypes(signal?: AbortSignal) {
  return readActiveStudioTypesWithClient(await createComponentSupabaseClient(), signal);
}

export async function readActiveStudioTaxonomies(signal?: AbortSignal) {
  return readActiveStudioTaxonomiesWithClient(await createComponentSupabaseClient(), signal);
}
