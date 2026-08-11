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

    expect(content).toContain("const pendingProfile = useRef<ProfileCompletePayload>(undefined);");
    expect(content).toContain("const pendingUpdate = useRef<ProfileUpdatePayload>(undefined);");
    expect(content).toContain("pendingProfile.current = undefined;");
    expect(content.match(/pendingUpdate\.current = undefined;/gu)).toHaveLength(2);
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
    expect(content).toContain("newestAccountProfileResult(");
    expect(content).toContain(
      "readNewestAccountProfileResult(queryClient, userId, readOwnProfile)",
    );
    expect(content).toContain("void queryClient.invalidateQueries({ queryKey });");
    expect(content).toContain("onScopeTransition();");
    expect(content).toContain("setScopeTransitionStarted(true);");
    expect(content).toContain("scopeTransitionStarted ||");
    expect(content).not.toContain(
      "applyVisualPreference(document.documentElement, result.profile.colorScheme)",
    );
    expect(content).toContain("window.location.reload();");
    expect(boundary).not.toContain("useQuery({");
    expect(boundary.indexOf("if (!seedIsCurrent)")).toBeLessThan(
      boundary.indexOf("<PreparedAccountProfilePanel"),
    );
  });

  it("passes only account return targets through the ephemeral login payload", () => {
    const page = readFileSync(resolve(process.cwd(), "src/app/entrar/page.tsx"), "utf8");
    const panel = componentSource("login-panel.tsx");

    expect(page).toContain('query.retorno === "/conta"');
    expect(page).toContain('query.retorno === "/conta/seguranca"');
    expect(panel).toContain("...(returnTo === undefined ? {} : { returnTo })");
    expect(panel).toContain("pendingLogin.current = parsed.data");
    expect(panel).toContain("mutation.mutate();");
  });

  it("clears every private cache before leaving the security page on logout", () => {
    const content = componentSource("account-security-panel.tsx");
    const mutation = content.slice(content.indexOf("const logoutMutation = useMutation"));

    expect(mutation.match(/queryClient\.clear\(\);/gu)).toHaveLength(2);
    expect(mutation.indexOf("queryClient.clear();")).toBeLessThan(
      mutation.indexOf('window.location.replace("/entrar?saida=verificar")'),
    );
    expect(mutation.lastIndexOf("queryClient.clear();")).toBeLessThan(
      mutation.indexOf('window.location.replace("/entrar")'),
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
