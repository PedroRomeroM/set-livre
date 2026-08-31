const contentSecurityPolicyNoncePattern = /^[a-f0-9]{32}$/u;
const loopbackHostnames = new Set(["127.0.0.1", "::1", "localhost"]);

export const contentSecurityPolicyHeaderName = "Content-Security-Policy";
export const contentSecurityPolicyNonceHeaderName = "x-nonce";

interface ContentSecurityPolicyOptions {
  allowLoopbackHttpImageOrigins?: boolean;
  imageOrigins?: readonly string[];
}

function normalizeImageOrigins(origins: readonly string[], allowLoopbackHttp: boolean) {
  return [...new Set(origins.map((origin) => normalizeImageOrigin(origin, allowLoopbackHttp)))];
}

function normalizeImageOrigin(origin: string, allowLoopbackHttp: boolean) {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("Uma origem de imagem da Content Security Policy é inválida.");
  }

  const isSecure = parsed.protocol === "https:";
  const isLocalDevelopment =
    allowLoopbackHttp && parsed.protocol === "http:" && loopbackHostnames.has(parsed.hostname);
  if (
    origin !== parsed.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (!isSecure && !isLocalDevelopment)
  ) {
    throw new Error("Uma origem de imagem da Content Security Policy é inválida.");
  }
  return parsed.origin;
}

export function createContentSecurityPolicy(
  nonce: string,
  isDevelopment: boolean,
  {
    allowLoopbackHttpImageOrigins = isDevelopment,
    imageOrigins = [],
  }: ContentSecurityPolicyOptions = {},
) {
  if (!contentSecurityPolicyNoncePattern.test(nonce)) {
    throw new Error("O nonce da Content Security Policy possui formato inválido.");
  }
  const normalizedImageOrigins = normalizeImageOrigins(imageOrigins, allowLoopbackHttpImageOrigins);

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ["img-src", "'self'", "data:", "blob:", ...normalizedImageOrigins].join(" "),
    "font-src 'self' data:",
    "frame-src https://www.youtube-nocookie.com",
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    `connect-src 'self'${isDevelopment ? " http://127.0.0.1:* ws://127.0.0.1:*" : ""}`,
  ].join("; ");
}
