import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("identity session security", () => {
  it("keeps only non-secret recovery cookie constants in process memory", async () => {
    const { recoveryGrantCookieName, recoveryGrantMaximumAgeSeconds } =
      await import("../../src/domains/identity/server/recovery-grant");

    expect(recoveryGrantCookieName).toBe("sl-recovery-grant");
    expect(recoveryGrantMaximumAgeSeconds).toBe(15 * 60);
  });

  it.each(["local", "test"] as const)(
    "configures server-owned cookies for the exact %s loopback runtime",
    async (appEnvironment) => {
      vi.stubEnv("APP_ENV", appEnvironment);
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3000");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "local-anon-key");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
      const { readSupabaseEnvironment } = await import("../../src/lib/supabase/config");

      expect(readSupabaseEnvironment()).toMatchObject({
        appOrigin: "http://127.0.0.1:3000",
        cookieOptions: { httpOnly: true, path: "/", sameSite: "lax", secure: false },
        supabaseOrigin: "http://127.0.0.1:54321",
      });

      vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3000/attacker");
      expect(() => readSupabaseEnvironment()).toThrow("origem sem path");
      vi.unstubAllEnvs();
    },
  );

  it("keeps cookies secure outside the exact local runtime", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dev.setlivre.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "local-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.dev.setlivre.example");
    const { readSupabaseEnvironment } = await import("../../src/lib/supabase/config");

    expect(readSupabaseEnvironment().cookieOptions.secure).toBe(true);

    vi.stubEnv("APP_ENV", "local");
    expect(() => readSupabaseEnvironment()).toThrow("origens HTTP IPv4 literais");
    vi.unstubAllEnvs();
  });

  it.each(["development", "production"] as const)(
    "rejects plaintext Auth origins in %s",
    async (appEnvironment) => {
      vi.stubEnv("APP_ENV", appEnvironment);
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://dev.setlivre.example");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.dev.setlivre.example");
      const { readSupabaseEnvironment } = await import("../../src/lib/supabase/config");

      expect(() => readSupabaseEnvironment()).toThrow("origens HTTPS");
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dev.setlivre.example");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.dev.setlivre.example");
      expect(() => readSupabaseEnvironment()).toThrow("origens HTTPS");
      vi.unstubAllEnvs();
    },
  );
});

describe("local Auth templates", () => {
  it.each([
    ["confirmation", "signup"],
    ["recovery", "recovery"],
  ] as const)("uses a direct token-hash callback for %s", (template, type) => {
    const content = readFileSync(
      resolve(process.cwd(), `supabase/templates/${template}.html`),
      "utf8",
    );
    expect(content).toContain(`{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=${type}`);
    expect(content).not.toContain(".ConfirmationURL");
    expect(content).not.toContain("auth/v1/verify");
    expect(content).not.toMatch(/https?:\/\//);
  });

  it("pins confirmation and recovery templates in the local Auth configuration", () => {
    const configuration = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8");
    expect(configuration).toContain("enable_confirmations = true");
    expect(configuration).toContain("minimum_password_length = 10");
    expect(configuration).toContain('password_requirements = "lower_upper_letters_digits"');
    expect(configuration).toContain("[auth.email.template.confirmation]");
    expect(configuration).toContain("[auth.email.template.recovery]");
  });
});

describe("identity mutation cache security", () => {
  it.each([
    ["registration-form.tsx", "pendingRegistration"],
    ["login-panel.tsx", "pendingLogin"],
  ] as const)("keeps credentials out of TanStack variables in %s", (fileName, referenceName) => {
    const content = readFileSync(
      resolve(process.cwd(), `src/domains/identity/components/${fileName}`),
      "utf8",
    );

    expect(content).toContain("mutationFn: () =>");
    expect(content).toContain("mutation.mutate();");
    expect(content).toContain(`${referenceName}.current = undefined;`);
    expect(content).not.toMatch(/mutation\.mutate\((?:parsed\.data|registrationPayload)/u);
  });

  it("keeps recovery e-mail and passwords out of TanStack mutation variables", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/recovery-flow.tsx"),
      "utf8",
    );

    expect(content.match(/mutationFn: \(\) =>/gu)).toHaveLength(2);
    expect(content.match(/mutation\.mutate\(\);/gu)).toHaveLength(2);
    expect(content).toContain("pendingRecoveryEmail.current = undefined;");
    expect(content).toContain("pendingRecoveryPassword.current = undefined;");
    expect(content).not.toMatch(/mutation\.mutate\((?:parsed\.data|password|email)/u);
  });

  it("revalidates the one-shot recovery grant after updates and window focus", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/recovery-flow.tsx"),
      "utf8",
    );

    expect(content).toContain('refetchOnWindowFocus: "always"');
    expect(content).toContain("await queryClient.invalidateQueries({");
    expect(content).toContain(
      "queryClient.removeQueries({ queryKey: identityQueryKeys.sessions });",
    );
    expect(content).toContain("identityRecoveryStatusCanAuthorize(");
    expect(content).toContain("statusQuery.fetchStatus");
    expect(content).toContain('statusQuery.fetchStatus !== "idle"');
    expect(content).not.toContain("statusRefreshing");
  });

  it("hides private session data and reloads SSR after an uncertain logout", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/login-panel.tsx"),
      "utf8",
    );

    expect(content).toContain("onError: () => {");
    expect(content).toContain(
      "redactIdentitySessionCacheForReload(queryClient, identitySessionScope(session));",
    );
    expect(content).toContain("if (logoutMutation.isError)");
    expect(content).toContain("antes de exibir dados privados");
    expect(content).toContain('window.location.replace("/entrar?saida=verificar")');
    expect(content).toContain("A sessão ainda está ativa");
    expect(content).toContain("A revalidação confirmou que não há uma sessão ativa");
  });

  it("scopes session queries and hides PII throughout an authoritative transition", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/login-panel.tsx"),
      "utf8",
    );

    expect(content).toContain(
      "const sessionQueryKey = useMemo(() => identityQueryKeys.session(sessionScope)",
    );
    expect(content).toContain("queryKey: sessionQueryKey");
    expect(content).toContain("function PreparedLoginPanel");
    expect(content).not.toContain("useSyncExternalStore");
    expect(content).not.toContain("getQueryCache().subscribe");
    expect(content).toContain(
      "queryClient.removeQueries({ queryKey: identityQueryKeys.sessions })",
    );
    expect(content).toContain("queryClient.setQueryData(sessionQueryKey, initialSession)");
    expect(content).toContain("queueMicrotask(() => {");
    expect(content).toContain(
      "identitySessionCanRender(observedSession, sessionScope, sessionQuery.fetchStatus)",
    );
    expect(content).toContain("observedScopeChanged");
    expect(content).toContain("identitySessionForScope(await readIdentitySession(), sessionScope)");
    expect(content).toContain("sessionQuery.error instanceof IdentitySessionScopeChangedError");
    expect(content).toContain("setSessionTransitionStarted(true);");
    expect(content).toContain("queryClient.clear();");
    expect(content).toContain(
      "queryClient.setQueryData(identityQueryKeys.session(previousScope), { authenticated: false });",
    );
    expect(content).toContain('window.location.replace("/entrar")');
    expect(content).toContain("Validando sua sessão…");
    const boundary = content.slice(content.indexOf("export function LoginPanel"));
    expect(boundary).not.toContain("useQuery({");
    expect(boundary.indexOf("if (!seedIsCurrent)")).toBeLessThan(
      boundary.indexOf("<PreparedLoginPanel"),
    );
  });

  it("keeps registration and recovery password fields uncontrolled", () => {
    for (const fileName of ["registration-form.tsx", "recovery-flow.tsx"]) {
      const content = readFileSync(
        resolve(process.cwd(), `src/domains/identity/components/${fileName}`),
        "utf8",
      );

      expect(content).toContain('confirmPassword: formValue(form, "confirmPassword")');
      expect(content).toContain('password: formValue(form, "password")');
      expect(content).not.toMatch(/const \[\s*(?:confirmPassword|password)\s*,/u);
      expect(content).not.toMatch(/value=\{(?:confirmPassword|password)\}/u);
      expect(content).not.toMatch(/\bset(?:Confirm)?Password\(/u);
    }
  });

  it("reads the registration choice from the native form without hydration state", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/registration-form.tsx"),
      "utf8",
    );

    expect(content).toContain('personType: formValue(form, "personType")');
    expect(content).toContain('defaultValue="individual"');
    expect(content).not.toMatch(/useState<PersonType>/u);
    expect(content).not.toContain("onValueChange={setPersonType}");
    expect(content).not.toContain("value={personType}");
  });

  it("stages E2E passwords outside the DOM through a redacted evaluate step", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-002-authentication.ts"),
      "utf8",
    );
    const specs = [
      "tests/e2e/critical/feat-002-authentication.spec.ts",
      "tests/e2e/regression/feat-002-authentication.spec.ts",
      "tests/e2e/reflow/feat-002-authentication.spec.ts",
    ]
      .map((fileName) => readFileSync(resolve(process.cwd(), fileName), "utf8"))
      .join("\n");

    expect(helper).toContain("const staging = await control.evaluate(");
    expect(helper).toContain("element.ownerDocument.defaultView?.HTMLInputElement");
    expect(helper).toContain('element.name !== "password"');
    expect(helper).toContain('element.name !== "confirmPassword"');
    expect(helper).toMatch(/element\.form\.addEventListener\(\s*"formdata"/u);
    expect(helper).toContain("event.formData.set(name, secret);");
    expect(helper).toContain("{ once: true }");
    expect(helper).not.toMatch(/\.value\s*=\s*(?:password|secret)/u);
    expect(helper).not.toContain("Object.getOwnPropertyDescriptor");
    for (const pattern of [
      "/^Senha\\*?$/u",
      "/^Confirme a senha\\*?$/u",
      "/^Nova senha\\*?$/u",
      "/^Confirme a nova senha\\*?$/u",
    ]) {
      expect(helper).toContain(pattern);
    }
    expect(`${helper}\n${specs}`).not.toMatch(
      /getByLabel\(["'](?:Confirme a nova senha|Confirme a senha|Nova senha|Senha)["']/u,
    );
    expect(helper).not.toContain("_valueTracker");
    expect(helper).not.toContain("dispatchEvent");
    expect(helper).not.toContain("keyboard.insertText");
    expect(helper).not.toMatch(/\bcontrol\.(?:fill|pressSequentially|type)\(/u);
    expect(specs).not.toMatch(
      /\.(?:fill|insertText|pressSequentially|type)\(\s*(?:identity\.password|missingIdentity\.password|newPassword|password)\b/u,
    );
  });

  it("clears stale remote errors before every new local form validation", () => {
    for (const fileName of ["registration-form.tsx", "login-panel.tsx"]) {
      const content = readFileSync(
        resolve(process.cwd(), `src/domains/identity/components/${fileName}`),
        "utf8",
      );
      expect(content).toContain("event.preventDefault();\n    mutation.reset();");
    }

    const recovery = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/recovery-flow.tsx"),
      "utf8",
    );
    expect(
      recovery.match(
        /mutation\.reset\(\);\n    setFieldErrors\(\{\}\);\n    const form = new FormData/gu,
      ),
    ).toHaveLength(2);
  });

  it("retains a callback token only for an active retryable callback", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/auth-callback-panel.tsx"),
      "utf8",
    );

    expect(content).not.toContain("useMutation");
    expect(content).toContain("const callbackPayload = useRef<CallbackPayload>(undefined);");
    expect(content).toContain("const [state, setState] = useState<CallbackState>");
    expect(content).toContain(
      "isRetryableIdentityCallbackError(error, callbackPayload.current.type)",
    );
    expect(content).toContain("if (!retryable)");
    expect(content).toContain('setState({ error, retryable, status: "error" });');
    expect(content.match(/callbackPayload\.current = undefined;/gu)).toHaveLength(2);
    expect(content).not.toContain("MutationCache");
  });
});
