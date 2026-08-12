import "server-only";

import { myProfileResultSchema, type Database, type MyProfileResult } from "@set-livre/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createComponentSupabaseClient } from "@/lib/supabase/server";

import { parseProfileDalRow, type ProfileDalRow } from "./profile-dal";

export function mapMyProfileRow(row: ProfileDalRow): MyProfileResult {
  if (
    !row.profile_completed &&
    (row.name !== null ||
      row.phone_e164 !== null ||
      row.tax_id_masked !== null ||
      row.additional_document_masked !== null)
  ) {
    throw new Error("O perfil incompleto contém um estado pessoal inconsistente.");
  }
  const common = {
    colorScheme: row.color_scheme,
    personType: row.person_type,
    preferencesVersion: row.preferences_version,
    profileVersion: row.profile_version,
    status: row.status,
  } as const;
  const profile = row.profile_completed
    ? {
        ...common,
        additionalDocumentMasked: row.additional_document_masked,
        completed: true as const,
        name: row.name,
        phone: row.phone_e164,
        taxIdMasked: row.tax_id_masked,
      }
    : {
        ...common,
        additionalDocumentMasked: null,
        completed: false as const,
        name: null,
        phone: null,
        taxIdMasked: null,
      };
  return myProfileResultSchema.parse({ profile, scope: row.user_id });
}

export function mapOwnProfileRow(row: ProfileDalRow, userId: string) {
  const profile = mapMyProfileRow(row);
  if (profile.scope !== userId) {
    throw new Error("O perfil retornado não corresponde à sessão autenticada.");
  }
  return profile;
}

async function readOwnProfileWithClient(
  client: SupabaseClient<Database>,
  userId: string,
  signal?: AbortSignal,
) {
  const query = client.rpc("get_my_profile");
  const abortableQuery = signal === undefined ? query : query.abortSignal(signal);
  const { data, error } = await abortableQuery.maybeSingle();
  if (error !== null) {
    throw new Error("Não foi possível carregar o perfil autenticado.");
  }
  return mapOwnProfileRow(parseProfileDalRow(data), userId);
}

export async function readOwnProfile(userId: string, signal?: AbortSignal) {
  return readOwnProfileWithClient(await createComponentSupabaseClient(), userId, signal);
}
