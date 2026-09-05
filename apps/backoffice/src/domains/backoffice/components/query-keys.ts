"use client";

export const backofficeQueryKeys = {
  session: (scope: string) => ["backoffice", "session", scope] as const,
  studio: (scope: string, studioId: string) => ["backoffice", "studios", scope, studioId] as const,
  studios: (scope: string) => ["backoffice", "studios", scope] as const,
  taxonomies: (scope: string) => ["backoffice", "taxonomies", scope] as const,
  users: (scope: string, filterFingerprint: string) =>
    ["backoffice", "users", scope, filterFingerprint] as const,
};

export async function backofficeFilterFingerprint(value: string) {
  const bytes = new TextEncoder().encode(value.trim().toLocaleLowerCase("pt-BR"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
