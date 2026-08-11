import "server-only";

import type { Database } from "@set-livre/contracts";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { readSupabaseEnvironment } from "./config";

export async function createRouteSupabaseClient() {
  const environment = readSupabaseEnvironment();
  const cookieStore = await cookies();
  const responseHeaders = new Headers();
  const client = createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: { flowType: "pkce" },
    cookieOptions: environment.cookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, options, value } of cookiesToSet) {
          cookieStore.set(name, value, { ...options, ...environment.cookieOptions });
        }
        for (const [name, value] of Object.entries(headers)) {
          responseHeaders.set(name, value);
        }
      },
    },
  });

  return { client, responseHeaders };
}

export async function createComponentSupabaseClient() {
  const environment = readSupabaseEnvironment();
  const cookieStore = await cookies();
  return createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: { flowType: "pkce" },
    cookieOptions: environment.cookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, options, value } of cookiesToSet) {
            cookieStore.set(name, value, { ...options, ...environment.cookieOptions });
          }
        } catch {
          // O proxy renova a sessão quando Server Components não podem publicar cookies.
        }
      },
    },
  });
}

export function createAnonymousSupabaseClient() {
  const environment = readSupabaseEnvironment();
  return createClient<Database>(environment.supabaseOrigin, environment.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      persistSession: false,
    },
  });
}
