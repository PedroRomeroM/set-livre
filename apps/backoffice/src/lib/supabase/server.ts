import "server-only";

import type { Database } from "@set-livre/contracts";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { readBackofficeSupabaseEnvironment } from "./config";

type BackofficeSupabaseClientOptions = Readonly<{ signal?: AbortSignal }>;

function createBackofficeSignalBoundFetch(signal: AbortSignal): typeof globalThis.fetch {
  return (input, init) => {
    const requestSignal = init?.signal;
    const effectiveSignal =
      requestSignal === undefined || requestSignal === null || requestSignal === signal
        ? signal
        : AbortSignal.any([signal, requestSignal]);
    return globalThis.fetch(input, { ...init, signal: effectiveSignal });
  };
}

function signalBoundGlobalOptions(options?: BackofficeSupabaseClientOptions) {
  return options?.signal === undefined
    ? {}
    : { global: { fetch: createBackofficeSignalBoundFetch(options.signal) } };
}

export function mergeBackofficeSupabaseResponseHeaders(target: Headers, source: Headers) {
  for (const [name, value] of source) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "set-cookie") continue;
    if (normalizedName === "x-middleware-set-cookie" && target.has(name)) {
      target.append(name, value);
      continue;
    }
    target.set(name, value);
  }
  for (const cookie of source.getSetCookie()) {
    target.append("set-cookie", cookie);
  }
}

export async function withBackofficeSupabaseResponseHeaderMerge<T>(
  target: Headers,
  execute: (capture: (source: Headers) => void) => Promise<T>,
) {
  let source: Headers | undefined;
  try {
    return await execute((headers) => {
      source = headers;
    });
  } finally {
    if (source !== undefined) {
      mergeBackofficeSupabaseResponseHeaders(target, source);
    }
  }
}

export async function createBackofficeRouteSupabaseClient(
  options?: BackofficeSupabaseClientOptions,
) {
  const environment = readBackofficeSupabaseEnvironment();
  const cookieStore = await cookies();
  const cookieResponse = new NextResponse(null);
  const { name: cookieStorageKey, ...forcedCookieOptions } = environment.cookieOptions;
  const client = createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: { flowType: "pkce" },
    cookieOptions: { ...forcedCookieOptions, name: cookieStorageKey },
    ...signalBoundGlobalOptions(options),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, options, value } of cookiesToSet) {
          const cookieOptions = { ...options, ...forcedCookieOptions };
          cookieStore.set(name, value, cookieOptions);
          cookieResponse.cookies.set(name, value, cookieOptions);
        }
        for (const [name, value] of Object.entries(headers)) {
          cookieResponse.headers.set(name, value);
        }
      },
    },
  });

  return { client, responseHeaders: cookieResponse.headers };
}

export async function createBackofficeComponentSupabaseClient(
  options?: BackofficeSupabaseClientOptions,
) {
  const environment = readBackofficeSupabaseEnvironment();
  const cookieStore = await cookies();
  const { name: cookieStorageKey, ...forcedCookieOptions } = environment.cookieOptions;
  return createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: { flowType: "pkce" },
    cookieOptions: { ...forcedCookieOptions, name: cookieStorageKey },
    ...signalBoundGlobalOptions(options),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, options, value } of cookiesToSet) {
            cookieStore.set(name, value, { ...options, ...forcedCookieOptions });
          }
        } catch {
          // O proxy publica a renovação quando o Server Component não pode alterar cookies.
        }
      },
    },
  });
}

export function createBackofficeTransientSupabaseClient() {
  const environment = readBackofficeSupabaseEnvironment();
  return createClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      persistSession: false,
    },
  });
}
