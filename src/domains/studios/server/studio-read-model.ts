import "server-only";

import {
  ownerStudioEditorCreateResultSchema,
  studioTypeOptionSchema,
  type OwnerStudioEditorResult,
  type StudioTypeOption,
} from "@set-livre/contracts";
import { z } from "zod";

import { readOwnerRecipient } from "@/domains/owners/server/owner-read-model";
import { ApiRouteError } from "@/lib/server/api-route";
import { createComponentSupabaseClient } from "@/lib/supabase/server";

import { mapOwnerStudioEditorDalRow, parseOwnerStudioEditorDalRow } from "./studio-dal";

const studioReadDeadlineMs = 2_000;
const studioTypeRowsSchema = z.array(studioTypeOptionSchema);
const studioReadIdentitySchema = z.strictObject({
  studioId: z.uuid().optional(),
  userId: z.uuid(),
});

type ComponentSupabaseClient = Awaited<ReturnType<typeof createComponentSupabaseClient>>;

async function withStudioReadDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
) {
  const abortController = new AbortController();
  const abortError = new DOMException("A leitura do estúdio expirou.", "AbortError");
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    abortController.signal.addEventListener("abort", () => reject(abortError), { once: true });
  });
  const abortFromExternalSignal = () => abortController.abort();
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    const operationOutcome = Promise.resolve().then(() => operation(abortController.signal));
    const outcome = Promise.race([operationOutcome, abortOutcome]);

    if (externalSignal?.aborted === true) {
      abortFromExternalSignal();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
    deadline = setTimeout(() => abortController.abort(), studioReadDeadlineMs);
    return await outcome;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

async function readActiveStudioTypesWithClient(
  client: ComponentSupabaseClient,
  signal: AbortSignal,
): Promise<StudioTypeOption[]> {
  const query = client.rpc("list_active_studio_types");
  const { data, error } = await Promise.resolve(query.abortSignal(signal));
  if (error !== null) {
    throw new Error("Não foi possível carregar os tipos de estúdio disponíveis.");
  }
  return studioTypeRowsSchema.parse(data);
}

async function readOwnerStudioRowWithClient(
  client: ComponentSupabaseClient,
  studioId: string,
  signal: AbortSignal,
) {
  const query = client.rpc("get_owner_studio_editor", { p_studio_id: studioId });
  const { data, error } = await Promise.resolve(query.abortSignal(signal).maybeSingle());
  if (error !== null) {
    throw new Error("Não foi possível carregar o editor do estúdio autenticado.");
  }
  if (data === null) {
    throw new ApiRouteError(404, "NOT_FOUND", "O estúdio não foi encontrado.");
  }
  return parseOwnerStudioEditorDalRow(data);
}

export async function readActiveStudioTypes(signal?: AbortSignal) {
  return withStudioReadDeadline(async (internalSignal) => {
    const client = await createComponentSupabaseClient();
    return readActiveStudioTypesWithClient(client, internalSignal);
  }, signal);
}

export async function readOwnerStudioEditor(
  userId: string,
  studioId?: string,
  signal?: AbortSignal,
): Promise<OwnerStudioEditorResult> {
  const identity = studioReadIdentitySchema.parse({ studioId, userId });
  return withStudioReadDeadline(async (internalSignal) => {
    const owner = await readOwnerRecipient(identity.userId, internalSignal);
    if (owner.ownerStatus !== "active") {
      throw new ApiRouteError(
        403,
        "FORBIDDEN",
        "Esta conta não pode gerenciar estúdios no estado atual.",
      );
    }
    const client = await createComponentSupabaseClient();
    const studioTypesOutcome = readActiveStudioTypesWithClient(client, internalSignal);

    if (identity.studioId === undefined) {
      return ownerStudioEditorCreateResultSchema.parse({
        mode: "create",
        projection: "studio_editor",
        scope: identity.userId,
        studio: null,
        studioTypes: await studioTypesOutcome,
      });
    }

    const [studioTypes, row] = await Promise.all([
      studioTypesOutcome,
      readOwnerStudioRowWithClient(client, identity.studioId, internalSignal),
    ]);
    return mapOwnerStudioEditorDalRow(row, identity.userId, studioTypes);
  }, signal);
}
