import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function componentSource(fileName: string) {
  return readFileSync(
    resolve(process.cwd(), `src/domains/identity/components/${fileName}`),
    "utf8",
  );
}

describe("profile UI privacy guards", () => {
  it("keeps raw tax and document fields in uncontrolled forms and one-shot refs", () => {
    const content = componentSource("account-profile-panel.tsx");
    const mutationBoundary = componentSource("profile-mutation.ts");

    expect(content).toContain(
      "const pendingProfile = useRef<ProfileMutationAttempt<ProfileCompletePayload>>(undefined);",
    );
    expect(
      content.match(
        /const pendingUpdate = useRef<ProfileMutationAttempt<ProfileUpdatePayload>>\(undefined\);/gu,
      ),
    ).toHaveLength(2);
    expect(
      content.match(
        /pending(?:Profile|Update)\.current = \{ expectedScope, payload: parsed\.data \};/gu,
      ),
    ).toHaveLength(3);
    expect(mutationBoundary).toContain('profileMutationNetworkMode = "always"');
    expect(content.match(/networkMode: profileMutationNetworkMode/gu)).toHaveLength(3);
    expect(content.match(/pending(?:Profile|Update)\.current = undefined;/gu)).toHaveLength(3);
    expect(mutationBoundary).toContain("clearAttempt();");
    expect(content.indexOf("cleanupAttemptOnce();")).toBeLessThan(
      content.indexOf("onSessionChanged();"),
    );
    expect(content).toContain("clearSensitiveInputs(formRef.current);");
    expect(content.match(/mutation\.mutate\(\);/gu)).toHaveLength(3);
    expect(content).not.toMatch(/mutation\.mutate\((?:parsed\.data|taxId|additionalDocument)/u);
    expect(content).not.toMatch(/useState\([^\n]*(?:taxId|additionalDocument)/u);
    expect(content).not.toMatch(/value=\{(?:taxId|additionalDocument)\}/u);
  });

  it("does not truncate masked profile values before contract validation", () => {
    const content = componentSource("account-profile-panel.tsx");
    const maskedInputs = (content.match(/<Input[\s\S]*?\/>/gu) ?? []).filter(
      (input) => input.includes('name="phone"') || input.includes('name="taxId"'),
    );

    expect(maskedInputs).toHaveLength(4);
    for (const input of maskedInputs) {
      expect(input).not.toContain("maxLength");
    }
    expect(content).toContain("formatBrazilianPhoneForDisplay(event.currentTarget.value)");
    expect(content).toContain("formatCpfForDisplay(event.currentTarget.value)");
    expect(content).toContain("formatCnpjForDisplay(event.currentTarget.value)");
  });

  it("uses a closed profile boundary and hides PII during every non-idle fetch", () => {
    const content = componentSource("account-profile-panel.tsx");
    const cache = componentSource("account-query-keys.ts");
    const mutationBoundary = componentSource("profile-mutation.ts");
    const boundary = content.slice(content.indexOf("export function AccountProfilePanel"));

    expect(content).toContain(
      "readNewestAccountProfileResult(queryClient, userId, readOwnProfile)",
    );
    expect(content).toContain(
      "accountProfileCanRender(observedProfile, userId, profileQuery.fetchStatus)",
    );
    expect(content).toContain('refetchOnMount: "always"');
    expect(content).toContain(
      "applyVisualPreference(document.documentElement, initialProfile.profile.colorScheme)",
    );
    expect(content).toContain(
      "applyVisualPreference(document.documentElement, renderablePreference)",
    );
    expect(content).toContain("clearIdentityAndAccountQueryCache(queryClient)");
    expect(content).toContain(
      "seedAuthoritativeAccountProfile(queryClient, userId, initialProfile)",
    );
    expect(content).toContain("publishNewestAccountProfileMutationResult(");
    expect(content).toContain(
      "readNewestAccountProfileResult(queryClient, userId, readOwnProfile)",
    );
    expect(cache).toContain("void queryClient.invalidateQueries({ queryKey });");
    expect(content).toContain("onScopeTransition();");
    expect(content).toContain("setScopeTransitionStarted(true);");
    expect(content).toContain("const scopeTransitionRequired =");
    expect(content).toContain("scopeTransitionStarted ||\n    scopeTransitionRequired ||");
    expect(
      content.match(/if \(!profileMutationResultCanPublish\(scopeTransitionGuard\)\) return;/gu),
    ).toHaveLength(8);
    expect(content).toContain('import { flushSync } from "react-dom";');
    expect(content).toContain("const executeScopeTransition = useCallback(");
    expect(content).toContain("const beginMutationScopeTransition = useCallback(() => {");
    expect(content).toContain("flushSync(() => {");
    expect(content).toContain("const beginObservedScopeTransition = useCallback(() => {");
    expect(content).toContain("beginObservedScopeTransition();");
    expect(content).toContain("useLayoutEffect(() => {");
    expect(content).toContain("if (!scopeTransitionRequired) return;");
    const observedTransition = content.slice(
      content.indexOf("const beginObservedScopeTransition"),
      content.indexOf("useEffect(() =>", content.indexOf("const beginObservedScopeTransition")),
    );
    expect(observedTransition).not.toContain("flushSync");
    expect(content).not.toContain("scopeTransitionBoundaryRef");
    expect(content).not.toContain("privateContentRef");
    expect(content).not.toContain("showProfileScopeTransitionBoundary");
    expect(mutationBoundary).not.toContain("replaceChildren");
    expect(mutationBoundary).toContain("guard.current = true;\n  try {\n    showBoundary();");
    expect(mutationBoundary).toContain(
      "} finally {\n    try {\n      clearPrivateCache();\n    } finally {\n      reload();",
    );
    expect(content).not.toContain(
      "applyVisualPreference(document.documentElement, result.profile.colorScheme)",
    );
    expect(content).toContain("window.location.reload();");
    expect(boundary).not.toContain("useQuery({");
    expect(boundary.indexOf("if (!seedIsCurrent)")).toBeLessThan(
      boundary.indexOf("<PreparedAccountProfilePanel"),
    );
  });

  it("passes only exact private return targets through the ephemeral login payload", () => {
    const page = readFileSync(resolve(process.cwd(), "src/app/entrar/page.tsx"), "utf8");
    const panel = componentSource("login-panel.tsx");

    expect(page).toContain("resolveAccountLoginReturnTarget(query.retorno)");
    expect(panel).toContain("returnTo?: AccountLoginReturnTarget | undefined");
    expect(panel).toContain("...(returnTo === undefined ? {} : { returnTo })");
    expect(panel).toContain("pendingLogin.current = parsed.data");
    expect(panel).toContain("mutation.mutate();");
  });

  it("clears every private cache before leaving the security page on logout", () => {
    const content = componentSource("account-security-panel.tsx");
    const mutation = content.slice(content.indexOf("const logoutMutation = useMutation"));

    expect(mutation).toContain("mutationFn: () => logoutIdentity(userId)");
    expect(mutation).toContain('networkMode: "always"');
    expect(mutation.match(/queryClient\.clear\(\);/gu)).toHaveLength(2);
    expect(mutation.indexOf("queryClient.clear();")).toBeLessThan(
      mutation.indexOf('window.location.replace("/entrar?saida=verificar")'),
    );
    expect(mutation.lastIndexOf("queryClient.clear();")).toBeLessThan(
      mutation.indexOf('window.location.replace("/entrar")'),
    );
    expect(mutation.indexOf("setSessionTransitionStarted(true);")).toBeLessThan(
      mutation.indexOf("logoutMutation.mutate();"),
    );
  });

  it("clears mutations and private query families in all three authoritative reseeds", () => {
    const cache = componentSource("account-query-keys.ts");
    const login = componentSource("login-panel.tsx");
    const profile = componentSource("account-profile-panel.tsx");
    const security = componentSource("account-security-panel.tsx");

    expect(cache.indexOf("clearIdentityAndAccountQueryCache(queryClient);")).toBeLessThan(
      cache.indexOf("queryClient.setQueryData(accountQueryKeys.profile(expectedUserId)"),
    );
    expect(cache.lastIndexOf("clearIdentityAndAccountQueryCache(queryClient);")).toBeLessThan(
      cache.indexOf(
        "queryClient.setQueryData(identityQueryKeys.session(identitySessionScope(session))",
      ),
    );
    expect(profile).toContain(
      "seedAuthoritativeAccountProfile(queryClient, userId, initialProfile)",
    );
    expect(login).toContain("seedAuthoritativeIdentitySession(queryClient, initialSession)");
    expect(security).toContain("seedAuthoritativeIdentitySession(queryClient, initialSession)");
    expect(cache).toContain(
      "queryClient.removeQueries({ queryKey: ownerQueryKeys.privateResults });",
    );
  });

  it("keeps the account composition usable at 320px and the 200% reflow viewport", () => {
    const styles = componentSource("account.module.css");

    expect(styles).toContain("min-height: var(--sl-control-height)");
    expect(styles).toContain("@media (max-width: 24rem)");
    expect(styles).toContain("@media (max-width: 12rem)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
  });
});
