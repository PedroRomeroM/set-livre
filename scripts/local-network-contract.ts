export const localIpv4Host = "127.0.0.1";

function rawUrlHostname(value: string): string | undefined {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) {
    return undefined;
  }

  const authorityStart = schemeSeparator + 3;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd =
    authorityEndOffset === -1 ? value.length : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);

  if (hostAndPort.startsWith("[")) {
    const closingBracket = hostAndPort.indexOf("]");
    return closingBracket === -1 ? undefined : hostAndPort.slice(0, closingBracket + 1);
  }

  const portSeparator = hostAndPort.lastIndexOf(":");
  return portSeparator === -1 ? hostAndPort : hostAndPort.slice(0, portSeparator);
}

export function parseLiteralLocalIpv4Url(value: unknown, label: string): URL {
  let source: string;
  let parsed: URL;
  try {
    source = typeof value === "string" ? value : String(value);
    parsed = new URL(source);
  } catch {
    throw new Error(`${label} é inválida.`);
  }

  if (parsed.hostname !== localIpv4Host || rawUrlHostname(source) !== localIpv4Host) {
    throw new Error(`${label} precisa usar o host IPv4 literal ${localIpv4Host}.`);
  }

  return parsed;
}
