const contentSecurityPolicyNoncePattern = /^[a-f0-9]{32}$/u;

export const contentSecurityPolicyHeaderName = "Content-Security-Policy";
export const contentSecurityPolicyNonceHeaderName = "x-nonce";

export function createContentSecurityPolicy(nonce: string, isDevelopment: boolean) {
  if (!contentSecurityPolicyNoncePattern.test(nonce)) {
    throw new Error("O nonce da Content Security Policy possui formato inválido.");
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "frame-src https://www.youtube-nocookie.com",
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    `connect-src 'self'${isDevelopment ? " http://127.0.0.1:* ws://127.0.0.1:*" : ""}`,
  ].join("; ");
}
