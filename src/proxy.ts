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

import { readSupabaseEnvironment } from "@/lib/supabase/config";

const globalErrorDocument = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Falha temporária · Set Livre</title>
  </head>
  <body>
    <main>
      <h1>Não foi possível carregar a aplicação</h1>
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

export async function proxy(request: NextRequest) {
  const nonce = randomUUID().replaceAll("-", "");
  const contentSecurityPolicy = createContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );

  if (request.nextUrl.pathname === "/_global-error") {
    return createGlobalErrorResponse(contentSecurityPolicy);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
  requestHeaders.set(contentSecurityPolicyNonceHeaderName, nonce);

  const environment = readSupabaseEnvironment();
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);

  if (shouldRefreshSession(request.nextUrl.pathname)) {
    const supabase = createServerClient<Database>(environment.supabaseOrigin, environment.anonKey, {
      auth: { flowType: "pkce" },
      cookieOptions: environment.cookieOptions,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          const refreshedRequestHeaders = new Headers(request.headers);
          refreshedRequestHeaders.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
          refreshedRequestHeaders.set(contentSecurityPolicyNonceHeaderName, nonce);
          response = NextResponse.next({ request: { headers: refreshedRequestHeaders } });
          response.headers.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
          for (const { name, options, value } of cookiesToSet) {
            response.cookies.set(name, value, { ...options, ...environment.cookieOptions });
          }
          for (const [name, value] of Object.entries(headers)) {
            response.headers.set(name, value);
          }
        },
      },
    });
    try {
      await supabase.auth.getClaims();
    } catch {
      // Falha de refresh não transforma uma rota pública em erro nem autentica a requisição.
    }
  }

  return response;
}

export const config = {
  matcher: ["/:path*"],
};
