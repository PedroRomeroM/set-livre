import "server-only";

import type { Database } from "@set-livre/contracts";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { readBackofficeSupabaseEnvironment } from "./config";

export async function createBackofficeRouteSupabaseClient() {
  const environment = readBackofficeSupabaseEnvironment();
  const cookieStore = await cookies();
  const cookieResponse = new NextResponse(null);
  const { name: cookieStorageKey, ...forcedCookieOptions } = environment.cookieOptions;
  const client = createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: { flowType: "pkce" },
    cookieOptions: { ...forcedCookieOptions, name: cookieStorageKey },
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

export async function createBackofficeComponentSupabaseClient() {
  const environment = readBackofficeSupabaseEnvironment();
  const cookieStore = await cookies();
  const { name: cookieStorageKey, ...forcedCookieOptions } = environment.cookieOptions;
  return createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: { flowType: "pkce" },
    cookieOptions: { ...forcedCookieOptions, name: cookieStorageKey },
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
