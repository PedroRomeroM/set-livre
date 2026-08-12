import "server-only";

import type { OwnerActivationResult, OwnerRecipientStatus } from "@set-livre/contracts";

import { createComponentSupabaseClient } from "@/lib/supabase/server";

import {
  mapOwnerActivationDalRow,
  mapOwnerRecipientStatusDalRow,
  parseOwnerActivationDalRow,
  parseOwnerRecipientStatusDalRow,
} from "./owner-dal";

const ownerReadDeadlineMs = 2_000;

type ComponentSupabaseClient = Awaited<ReturnType<typeof createComponentSupabaseClient>>;

async function readOwnerRecipientWithClient(
  client: ComponentSupabaseClient,
  userId: string,
  projection: "activation" | "recipient",
  externalSignal?: AbortSignal,
): Promise<OwnerActivationResult | OwnerRecipientStatus> {
  const abortController = new AbortController();
  const abortError = new DOMException("A leitura do cadastro de dono expirou.", "AbortError");
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    abortController.signal.addEventListener("abort", () => reject(abortError), { once: true });
  });
  const abortFromExternalSignal = () => abortController.abort();
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    const query = client.rpc(
      projection === "activation" ? "get_owner_activation_status" : "get_owner_recipient_status",
    );
    const rpcOutcome = Promise.resolve(
      query.abortSignal(abortController.signal).maybeSingle(),
    ).then(({ data, error }) => {
      if (error !== null) {
        throw new Error("Não foi possível carregar o cadastro de dono autenticado.");
      }
      return projection === "activation"
        ? mapOwnerActivationDalRow(parseOwnerActivationDalRow(data), userId)
        : mapOwnerRecipientStatusDalRow(parseOwnerRecipientStatusDalRow(data), userId);
    });
    const outcome = Promise.race([rpcOutcome, abortOutcome]);

    if (externalSignal?.aborted === true) {
      abortFromExternalSignal();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
    deadline = setTimeout(() => abortController.abort(), ownerReadDeadlineMs);
    return await outcome;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

export async function readOwnerRecipient(userId: string, signal?: AbortSignal) {
  const result = await readOwnerRecipientWithClient(
    await createComponentSupabaseClient(),
    userId,
    "recipient",
    signal,
  );
  if (result.projection !== "recipient") {
    throw new Error("A leitura de recebimentos retornou uma projeção inesperada.");
  }
  return result;
}

export async function readOwnerActivation(userId: string, signal?: AbortSignal) {
  const result = await readOwnerRecipientWithClient(
    await createComponentSupabaseClient(),
    userId,
    "activation",
    signal,
  );
  if (result.projection !== "activation") {
    throw new Error("A leitura de ativação retornou uma projeção inesperada.");
  }
  return result;
}
