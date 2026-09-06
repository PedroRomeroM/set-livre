import { expect } from "@playwright/test";

function scriptDirective(contentSecurityPolicy: string) {
  return (
    contentSecurityPolicy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src ")) ?? ""
  );
}

export function policyNonce(contentSecurityPolicy: string) {
  const scriptSource = scriptDirective(contentSecurityPolicy);
  const matches = [...scriptSource.matchAll(/'nonce-([a-f0-9]{32})'/gu)];
  expect(matches, "script-src deve declarar exatamente um nonce por request.").toHaveLength(1);
  expect(scriptSource).toContain("'strict-dynamic'");
  expect(scriptSource).not.toContain("'unsafe-eval'");
  expect(scriptSource).not.toContain("'unsafe-inline'");
  return matches[0]?.[1] ?? "";
}

export function expectRawHtmlScriptsUseNonce(html: string, nonce: string) {
  const scriptTags = html.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  expect(
    scriptTags.length,
    "O HTML precisa conter o bootstrap JavaScript do Next.",
  ).toBeGreaterThan(0);
  expect(
    scriptTags.every((scriptTag) => scriptTag.includes(`nonce="${nonce}"`)),
    "Todo script do HTML precisa usar o nonce da mesma response.",
  ).toBe(true);
}

export function expectPresentRawHtmlScriptsUseNonce(html: string, nonce: string) {
  const scriptTags = html.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  expect(
    scriptTags.every((scriptTag) => scriptTag.includes(`nonce="${nonce}"`)),
    "Todo script presente no HTML de erro precisa usar o nonce da mesma response.",
  ).toBe(true);
}
