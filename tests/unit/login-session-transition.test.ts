import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { IdentityApiError } from "../../src/domains/identity/components/identity-api";
import {
  handleAmbiguousLoginTransportError,
  hideAndResetLoginCredentialForm,
  isAmbiguousLoginTransportError,
  loginSessionVerificationPath,
  resolveAccountLoginReturnTarget,
} from "../../src/domains/identity/components/login-session-transition";

describe("ambiguous login session transition", () => {
  it.each([
    "AUTH_SESSION_RECHECK_REQUIRED",
    "NETWORK_UNAVAILABLE",
    "REQUEST_TIMEOUT",
    "RESPONSE_INVALID",
  ])("treats %s as an outcome that requires authoritative session verification", (code) => {
    expect(isAmbiguousLoginTransportError(new IdentityApiError(code, "Erro seguro."))).toBe(true);
  });

  it.each(["AUTH_INVALID", "RATE_LIMITED", "SERVICE_UNAVAILABLE"])(
    "keeps the valid API rejection %s recoverable in the login form",
    (code) => {
      expect(isAmbiguousLoginTransportError(new IdentityApiError(code, "Erro seguro."))).toBe(
        false,
      );
    },
  );

  it("redacts ephemeral credentials, form and caches before the authoritative reload", () => {
    const calls: string[] = [];
    const handled = handleAmbiguousLoginTransportError(
      new IdentityApiError("RESPONSE_INVALID", "Erro seguro."),
      {
        beginSessionTransition: () => calls.push("hide-session-boundary"),
        clearEphemeralCredentials: () => calls.push("clear-ref"),
        hideAndResetCredentialForm: () => calls.push("redact-form"),
        redactPrivateCaches: () => calls.push("clear-cache"),
        reloadAuthoritativeSession: () => calls.push("reload-ssr"),
      },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual([
      "clear-ref",
      "redact-form",
      "hide-session-boundary",
      "clear-cache",
      "reload-ssr",
    ]);
  });

  it("also redacts a valid API response that reports ambiguous cookie publication", () => {
    const calls: string[] = [];
    const handled = handleAmbiguousLoginTransportError(
      new IdentityApiError(
        "AUTH_SESSION_RECHECK_REQUIRED",
        "Não foi possível confirmar a entrada.",
      ),
      {
        beginSessionTransition: () => calls.push("hide-session-boundary"),
        clearEphemeralCredentials: () => calls.push("clear-ref"),
        hideAndResetCredentialForm: () => calls.push("redact-form"),
        redactPrivateCaches: () => calls.push("clear-cache"),
        reloadAuthoritativeSession: () => calls.push("reload-ssr"),
      },
    );

    expect(handled).toBe(true);
    expect(calls).toEqual([
      "clear-ref",
      "redact-form",
      "hide-session-boundary",
      "clear-cache",
      "reload-ssr",
    ]);
  });

  it("does not alter client state for an authoritative credential rejection", () => {
    const action = vi.fn();
    const handled = handleAmbiguousLoginTransportError(
      new IdentityApiError("AUTH_INVALID", "Credenciais inválidas."),
      {
        beginSessionTransition: action,
        clearEphemeralCredentials: action,
        hideAndResetCredentialForm: action,
        redactPrivateCaches: action,
        reloadAuthoritativeSession: action,
      },
    );

    expect(handled).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("hides and clears the uncontrolled credential form synchronously", () => {
    const form = { hidden: false, reset: vi.fn() };

    hideAndResetLoginCredentialForm(form);

    expect(form.hidden).toBe(true);
    expect(form.reset).toHaveBeenCalledOnce();
  });

  it("preserves only allowlisted private return targets in the verification reload", () => {
    expect(loginSessionVerificationPath()).toBe("/entrar?entrada=verificar");
    expect(loginSessionVerificationPath("/conta")).toBe(
      "/entrar?entrada=verificar&retorno=%2Fconta",
    );
    expect(loginSessionVerificationPath("/conta/seguranca")).toBe(
      "/entrar?entrada=verificar&retorno=%2Fconta%2Fseguranca",
    );
    expect(loginSessionVerificationPath("/dono")).toBe("/entrar?entrada=verificar&retorno=%2Fdono");
    expect(loginSessionVerificationPath("/dono/recebimentos")).toBe(
      "/entrar?entrada=verificar&retorno=%2Fdono%2Frecebimentos",
    );
    expect(loginSessionVerificationPath("/dono/estudios/novo")).toBe(
      "/entrar?entrada=verificar&retorno=%2Fdono%2Festudios%2Fnovo",
    );
    expect(
      loginSessionVerificationPath("/dono/estudios/11111111-1111-4111-8111-111111111111/dados"),
    ).toBe(
      "/entrar?entrada=verificar&retorno=%2Fdono%2Festudios%2F11111111-1111-4111-8111-111111111111%2Fdados",
    );
  });

  it.each([
    "/conta",
    "/conta/seguranca",
    "/dono",
    "/dono/recebimentos",
    "/dono/estudios/novo",
    "/dono/estudios/11111111-1111-4111-8111-111111111111/dados",
  ] as const)("accepts the exact login return target %s", (target) => {
    expect(resolveAccountLoginReturnTarget(target)).toBe(target);
  });

  it.each([
    "https://attacker.example/dono",
    "//attacker.example/dono",
    "/dono?next=https://attacker.example",
    "/dono/../conta",
    "/dono%2Frecebimentos",
    "/dono/estudios/11111111-1111-4111-8111-111111111111/dados?modo=editar",
    "/dono/estudios/11111111-1111-4111-8111-111111111111/dados#campos",
    "/dono/estudios%2F11111111-1111-4111-8111-111111111111%2Fdados",
    "/dono/estudios/../11111111-1111-4111-8111-111111111111/dados",
    "/dono/estudios\\11111111-1111-4111-8111-111111111111\\dados",
    "/dono/estudios/11111111-1111-0111-8111-111111111111/dados",
    "/dono/estudios/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/dados",
    ["/dono/estudios/11111111-1111-4111-8111-111111111111/dados"],
    ["/dono"],
    undefined,
  ])("rejects a non-allowlisted login return target: %s", (target) => {
    expect(resolveAccountLoginReturnTarget(target)).toBeUndefined();
  });

  it("wires the form boundary without passing credentials through mutation variables or URLs", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/login-panel.tsx"),
      "utf8",
    );
    const loginMutation = content.slice(
      content.indexOf("const mutation = useMutation"),
      content.indexOf("function submitLogin"),
    );

    expect(loginMutation).toContain("handleAmbiguousLoginTransportError(error");
    expect(loginMutation).toContain("pendingLogin.current = undefined;");
    expect(loginMutation).toContain("hideAndResetLoginCredentialForm(formRef.current);");
    expect(loginMutation).toContain(
      'redactIdentitySessionCacheForReload(queryClient, "anonymous")',
    );
    expect(loginMutation).toContain(
      "window.location.replace(loginSessionVerificationPath(returnTo));",
    );
    expect(loginMutation).not.toMatch(/mutation\.mutate\([^)]*(?:email|password|parsed\.data)/u);
    expect(loginMutation).not.toMatch(/location\.[^(]+\([^)]*(?:email|password)/u);
  });
});
