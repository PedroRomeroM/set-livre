import type { CurrentLegalDocuments } from "@set-livre/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createViteServer } from "vitest/node";

const legalDocuments = {
  privacy: {
    bodyMarkdown: "Privacidade local.",
    contentHash: "a".repeat(64),
    effectiveAt: "2026-08-11T00:00:00.000Z",
    id: "11111111-1111-4111-8111-111111111111",
    kind: "privacy",
    source: "local_fixture",
    title: "Política de Privacidade",
    version: "local-1",
  },
  terms: {
    bodyMarkdown: "Termos locais.",
    contentHash: "b".repeat(64),
    effectiveAt: "2026-08-11T00:00:00.000Z",
    id: "22222222-2222-4222-8222-222222222222",
    kind: "terms",
    source: "local_fixture",
    title: "Termos de Uso",
    version: "local-1",
  },
} satisfies CurrentLegalDocuments;

type RegistrationFormModule = {
  RegistrationForm: ComponentType<{ legalDocuments: CurrentLegalDocuments }>;
};

function isRegistrationFormModule(value: unknown): value is RegistrationFormModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "RegistrationForm" in value &&
    typeof value.RegistrationForm === "function"
  );
}

let registrationForm: RegistrationFormModule["RegistrationForm"];
let vite: Awaited<ReturnType<typeof createViteServer>>;

beforeAll(async () => {
  vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        enforce: "pre",
        name: "registration-form-ssr-test-tsx",
        transform(source, id) {
          if (!id.endsWith(".tsx")) {
            return null;
          }
          return transformWithOxc(source, id, {
            jsx: { runtime: "automatic" },
            lang: "tsx",
            target: "es2022",
          });
        },
      },
    ],
    resolve: {
      alias: { "@": resolve(process.cwd(), "src") },
    },
    root: process.cwd(),
    server: { middlewareMode: true },
  });
  const registrationFormModule: unknown = await vite.ssrLoadModule(
    "/src/domains/identity/components/registration-form.tsx",
  );
  if (!isRegistrationFormModule(registrationFormModule)) {
    throw new Error("O módulo SSR não publicou RegistrationForm.");
  }
  registrationForm = registrationFormModule.RegistrationForm;
});

afterAll(async () => {
  if (vite !== undefined) {
    await vite.close();
  }
});

function renderRegistrationServerMarkup() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
    },
  });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(registrationForm, { legalDocuments }),
    ),
  );
}

describe("registration form hydration boundary", () => {
  it("renders a fail-closed native form before React hydration", () => {
    const html = renderRegistrationServerMarkup();
    const formTag = html.match(/<form\b[^>]*>/u)?.[0];
    const disabledFieldset = html.match(
      /<fieldset\b[^>]*disabled=""[^>]*>[\s\S]*<\/fieldset>/u,
    )?.[0];

    expect(formTag).toBeDefined();
    expect(formTag).toContain('aria-busy="true"');
    expect(formTag).toContain('inert=""');
    expect(formTag).toContain('method="post"');
    expect(formTag).not.toContain("action=");
    expect(disabledFieldset).toBeDefined();
    expect(html).toContain('role="status"');
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf("<form"));
    expect(html).toContain("Preparando o formulário seguro…");

    const namedControls = [
      ...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="[^"]+"[^>]*>/gu),
    ].map(([tag]) => tag);
    expect(namedControls).toHaveLength(7);
    expect(namedControls.every((tag) => tag.includes('disabled=""'))).toBe(true);
    expect(disabledFieldset).toContain('name="email"');
    expect(disabledFieldset).toContain('name="password"');
    expect(disabledFieldset).toContain('name="confirmPassword"');

    const submitControl = html.match(/<button\b[^>]*type="submit"[^>]*>/u)?.[0];
    expect(submitControl).toBeDefined();
    expect(submitControl).toContain('disabled=""');
  });

  it("uses a hydration snapshot instead of enabling controls from an effect", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/domains/identity/components/registration-form.tsx"),
      "utf8",
    );

    expect(source).toContain("useSyncExternalStore(");
    expect(source).toMatch(/function readHydratedClientSnapshot\(\) \{\s*return true;\s*\}/u);
    expect(source).toMatch(/function readHydratedServerSnapshot\(\) \{\s*return false;\s*\}/u);
    expect(source.indexOf("readHydratedClientSnapshot")).toBeLessThan(
      source.indexOf("readHydratedServerSnapshot"),
    );
    expect(source).toContain("disabled={!isHydrated}");
    expect(source).toContain("inert={!isHydrated}");
    expect(source).toContain('method="post"');
    expect(source).not.toContain("useEffect(");
  });
});
