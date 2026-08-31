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
  closeIdentityRecoverySession,
  inspectIdentityRecoverySession,
} from "@/domains/identity/server/identity-dal";
import {
  parseAuthSessionContext,
  readSupabaseAccessTokenFromCookies,
  signOutLocalOrProveAbsent,
  supabaseAuthCookieNames,
} from "@/domains/identity/server/identity-auth-session";
import {
  recoveryGrantCookieName,
  recoverySessionCookieName,
} from "@/domains/identity/server/recovery-grant";
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

function isRecoverySessionSurface(pathname: string) {
  return (
    pathname === "/recuperar-senha" ||
    pathname === "/auth/callback" ||
    pathname === "/api/auth/callback" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/session" ||
    pathname === "/api/auth/recovery/request" ||
    pathname === "/api/auth/recovery/status" ||
    pathname === "/api/auth/recovery/update"
  );
}

export async function proxy(request: NextRequest) {
  const nonce = randomUUID().replaceAll("-", "");
  const isDevelopment = process.env.NODE_ENV === "development";

  if (request.nextUrl.pathname === "/_global-error") {
    return createGlobalErrorResponse(createContentSecurityPolicy(nonce, isDevelopment));
  }

  const environment = readSupabaseEnvironment();
  const contentSecurityPolicy = createContentSecurityPolicy(nonce, isDevelopment, {
    allowLoopbackHttpImageOrigins: new URL(environment.supabaseOrigin).protocol === "http:",
    imageOrigins: [environment.supabaseOrigin],
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
  requestHeaders.set(contentSecurityPolicyNonceHeaderName, nonce);

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
    const hasRecoveryMarker = request.cookies.get(recoverySessionCookieName) !== undefined;
    const hasRecoveryGrant = request.cookies.get(recoveryGrantCookieName) !== undefined;
    const clearCookies = async (includeAuth: boolean) => {
      const priorHeaders = new Headers(response.headers);
      const priorCookies = response.cookies.getAll();
      const cookieNamesToDelete = [recoveryGrantCookieName, recoverySessionCookieName];
      if (includeAuth) {
        cookieNamesToDelete.push(
          ...supabaseAuthCookieNames(
            { getAll: () => request.cookies.getAll() },
            environment.supabaseOrigin,
          ),
        );
      }
      let authCleanupError: unknown;
      if (includeAuth) {
        try {
          await signOutLocalOrProveAbsent(supabase.auth);
        } catch (error) {
          authCleanupError = error;
        }
      }
      for (const name of cookieNamesToDelete) {
        request.cookies.delete(name);
      }
      const anonymousRequestHeaders = new Headers(request.headers);
      anonymousRequestHeaders.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
      anonymousRequestHeaders.set(contentSecurityPolicyNonceHeaderName, nonce);
      response = NextResponse.next({ request: { headers: anonymousRequestHeaders } });
      for (const [name, value] of priorHeaders.entries()) {
        if (name.toLowerCase() !== "set-cookie") {
          response.headers.set(name, value);
        }
      }
      for (const cookie of priorCookies) {
        if (!cookieNamesToDelete.includes(cookie.name)) {
          response.cookies.set(cookie);
        }
      }
      response.headers.set(contentSecurityPolicyHeaderName, contentSecurityPolicy);
      for (const name of cookieNamesToDelete) {
        response.cookies.delete(name);
      }
      if (authCleanupError !== undefined) {
        throw authCleanupError;
      }
    };

    try {
      const accessToken = hasRecoveryMarker
        ? await readSupabaseAccessTokenFromCookies(
            { getAll: () => request.cookies.getAll() },
            environment.supabaseOrigin,
          )
        : undefined;
      if (hasRecoveryMarker && accessToken === undefined) {
        await clearCookies(false);
        return response;
      }
      const claimsResult = await supabase.auth.getClaims(accessToken);
      const authContext =
        claimsResult.error === null
          ? parseAuthSessionContext(claimsResult.data?.claims)
          : undefined;
      if (authContext !== undefined) {
        const recoveryBinding = await inspectIdentityRecoverySession({
          authExpiresAt: authContext.authExpiresAt,
          authSessionId: authContext.authSessionId,
          sessionScope: null,
          token: null,
          userId: authContext.userId,
        });
        if (recoveryBinding !== undefined && !isRecoverySessionSurface(request.nextUrl.pathname)) {
          try {
            await closeIdentityRecoverySession({
              authSessionId: authContext.authSessionId,
              userId: authContext.userId,
            });
          } catch {
            // O tombstone existente continua classificando qualquer replay como recovery.
          }
          await clearCookies(true);
        } else if (recoveryBinding === undefined && (hasRecoveryMarker || hasRecoveryGrant)) {
          await clearCookies(false);
        }
      } else if (hasRecoveryMarker || hasRecoveryGrant) {
        await clearCookies(false);
      }
    } catch {
      if (hasRecoveryMarker || hasRecoveryGrant) {
        await clearCookies(false);
      }
      const errorResponse = createGlobalErrorResponse(contentSecurityPolicy);
      for (const cookie of response.cookies.getAll()) {
        errorResponse.cookies.set(cookie);
      }
      return errorResponse;
    }
  }

  return response;
}

export const config = {
  matcher: ["/:path*"],
};
