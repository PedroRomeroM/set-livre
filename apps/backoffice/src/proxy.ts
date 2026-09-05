import {
  contentSecurityPolicyHeaderName,
  contentSecurityPolicyNonceHeaderName,
  createContentSecurityPolicy,
} from "@set-livre/contracts/content-security-policy";
import type { Database } from "@set-livre/contracts";
import { createServerClient } from "@supabase/ssr";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  backofficeAuthCookieNames,
  parseBackofficeAuthContext,
} from "@/domains/backoffice/server/auth-context";
import { createBackofficeContentSecurityPolicy } from "@/lib/content-security-policy";
import { readBackofficeSupabaseEnvironment } from "@/lib/supabase/config";

const globalErrorDocument = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Falha temporária · Set Livre Backoffice</title>
  </head>
  <body>
    <main>
      <h1>Não foi possível carregar o backoffice</h1>
      <p>Tente novamente. Se o problema continuar, aguarde alguns instantes.</p>
      <a href="/">Tentar novamente</a>
    </main>
  </body>
</html>`;

function createGlobalErrorResponse(contentSecurityPolicy: string) {
  return new NextResponse(globalErrorDocument, {
    headers: {
      "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
      [contentSecurityPolicyHeaderName]: contentSecurityPolicy,
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
    status: 500,
  });
}

function shouldRefreshSession(pathname: string) {
  return !pathname.startsWith("/_next/static/") && !pathname.startsWith("/_next/image/");
}

function applyBackofficeHeaders(response: NextResponse, contentSecurityPolicy: string) {
  response.headers.set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
  response.headers.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
}

export async function proxy(request: NextRequest) {
  const nonce = randomUUID().replaceAll("-", "");
  const isDevelopment = process.env.NODE_ENV === "development";

  if (request.nextUrl.pathname === "/_global-error") {
    return createGlobalErrorResponse(createContentSecurityPolicy(nonce, isDevelopment));
  }

  const environment = readBackofficeSupabaseEnvironment();
  const contentSecurityPolicy = createBackofficeContentSecurityPolicy(
    nonce,
    isDevelopment,
    environment.supabaseOrigin,
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
  requestHeaders.set(contentSecurityPolicyNonceHeaderName, nonce);

  const { name: cookieStorageKey, ...forcedCookieOptions } = environment.cookieOptions;
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  applyBackofficeHeaders(response, contentSecurityPolicy);

  const cookieNames = backofficeAuthCookieNames({ getAll: () => request.cookies.getAll() });
  if (cookieNames.length > 0 && shouldRefreshSession(request.nextUrl.pathname)) {
    const supabase = createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
      auth: { flowType: "pkce" },
      cookieOptions: { ...forcedCookieOptions, name: cookieStorageKey },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          const refreshedHeaders = new Headers(request.headers);
          refreshedHeaders.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
          refreshedHeaders.set(contentSecurityPolicyNonceHeaderName, nonce);
          response = NextResponse.next({ request: { headers: refreshedHeaders } });
          applyBackofficeHeaders(response, contentSecurityPolicy);
          for (const { name, options, value } of cookiesToSet) {
            response.cookies.set(name, value, { ...options, ...forcedCookieOptions });
          }
          for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
        },
      },
    });

    try {
      const claims = await supabase.auth.getClaims();
      if (claims.error !== null || parseBackofficeAuthContext(claims.data?.claims) === undefined) {
        for (const name of cookieNames) {
          request.cookies.delete(name);
        }
        const clearedHeaders = new Headers(request.headers);
        clearedHeaders.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
        clearedHeaders.set(contentSecurityPolicyNonceHeaderName, nonce);
        response = NextResponse.next({ request: { headers: clearedHeaders } });
        applyBackofficeHeaders(response, contentSecurityPolicy);
        for (const name of cookieNames) response.cookies.delete(name);
      }
    } catch {
      const errorResponse = createGlobalErrorResponse(contentSecurityPolicy);
      for (const cookie of response.cookies.getAll()) errorResponse.cookies.set(cookie);
      return errorResponse;
    }
  }
  return response;
}

export const config = {
  matcher: ["/:path*"],
};
