const contentSecurityPolicyNoncePattern = /^[a-f0-9]{32}$/u;
const loopbackHostnames = new Set(["127.0.0.1", "::1", "localhost"]);

export const contentSecurityPolicyHeaderName = "Content-Security-Policy";
export const contentSecurityPolicyNonceHeaderName = "x-nonce";

interface ContentSecurityPolicyOptions {
  allowLoopbackHttpConnectOrigins?: boolean;
  allowLoopbackHttpImageOrigins?: boolean;
  connectOrigins?: readonly string[];
  imageOrigins?: readonly string[];
}

function normalizeOrigins(
  origins: readonly string[],
  allowLoopbackHttp: boolean,
  resource: "conexão" | "imagem",
) {
  return [
    ...new Set(origins.map((origin) => normalizeOrigin(origin, allowLoopbackHttp, resource))),
  ];
}

function normalizeOrigin(
  origin: string,
  allowLoopbackHttp: boolean,
  resource: "conexão" | "imagem",
) {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Uma origem de ${resource} da Content Security Policy é inválida.`);
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
    throw new Error(`Uma origem de ${resource} da Content Security Policy é inválida.`);
  }
  return parsed.origin;
}

export function createContentSecurityPolicy(
  nonce: string,
  isDevelopment: boolean,
  {
    allowLoopbackHttpConnectOrigins = isDevelopment,
    allowLoopbackHttpImageOrigins = isDevelopment,
    connectOrigins = [],
    imageOrigins = [],
  }: ContentSecurityPolicyOptions = {},
) {
  if (!contentSecurityPolicyNoncePattern.test(nonce)) {
    throw new Error("O nonce da Content Security Policy possui formato inválido.");
  }
  const normalizedConnectOrigins = normalizeOrigins(
    connectOrigins,
    allowLoopbackHttpConnectOrigins,
    "conexão",
  );
  const normalizedImageOrigins = normalizeOrigins(
    imageOrigins,
    allowLoopbackHttpImageOrigins,
    "imagem",
  );

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
    [
      "connect-src",
      "'self'",
      ...normalizedConnectOrigins,
      ...(isDevelopment ? ["http://127.0.0.1:*", "ws://127.0.0.1:*"] : []),
    ].join(" "),
  ].join("; ");
}
