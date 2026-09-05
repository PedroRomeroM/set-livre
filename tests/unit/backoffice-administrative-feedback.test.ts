import type { BackofficeTaxonomyItem, BackofficeUserSummary } from "@set-livre/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BackofficeClientError } from "../../apps/backoffice/src/domains/backoffice/components/backoffice-api";
import {
  TaxonomyForm,
  taxonomyFieldErrors,
  taxonomyStatusNoticeFromRetainedState,
  taxonomyUpsertNoticeFromRetainedState,
} from "../../apps/backoffice/src/domains/backoffice/components/taxonomy-manager";
import { userStatusNoticeFromRetainedState } from "../../apps/backoffice/src/domains/backoffice/components/user-directory";

const targetId = "10000000-0000-4000-8000-000000000002";

const taxonomy: BackofficeTaxonomyItem = {
  active: false,
  id: targetId,
  kind: "tag",
  name: "Podcast",
  slug: "podcast",
  sortOrder: 4,
  updatedAt: "2026-09-04T10:00:00.000Z",
  usageCount: 3,
  version: 2,
};

const user: BackofficeUserSummary = {
  accountVersion: 2,
  createdAt: "2026-09-01T10:00:00.000Z",
  emailMasked: "p***@example.test",
  id: targetId,
  status: "suspended",
};

function expectInvalidControl(markup: string, tagName: "input" | "select", name: string) {
  const control = markup.match(new RegExp(`<${tagName}[^>]*name="${name}"[^>]*>`, "u"))?.[0];
  expect(control).toBeDefined();
  expect(control).toContain('aria-invalid="true"');
  expect(control).toMatch(/aria-describedby="[^"]+-error"/u);
}

describe("backoffice administrative feedback", () => {
  it("renders allowlisted taxonomy validation errors beside their controls", () => {
    const fieldErrors = taxonomyFieldErrors(
      new BackofficeClientError({
        code: "VALIDATION_ERROR",
        fieldErrors: {
          ignored: "Não pertence ao formulário.",
          kind: "Selecione um grupo válido.",
          name: "Use pelo menos 2 caracteres.",
          slug: "Use letras minúsculas, números e hífens.",
          sortOrder: "Use uma ordem entre 0 e 32767.",
        },
        message: "Revise os campos destacados.",
        status: 400,
      }),
    );

    expect(fieldErrors).toEqual({
      kind: "Selecione um grupo válido.",
      name: "Use pelo menos 2 caracteres.",
      slug: "Use letras minúsculas, números e hífens.",
      sortOrder: "Use uma ordem entre 0 e 32767.",
    });

    const markup = renderToStaticMarkup(
      createElement(TaxonomyForm, {
        blocked: false,
        fieldErrors,
        interactive: true,
        onCancel: vi.fn(),
        onRetry: vi.fn(),
        onSubmit: vi.fn(),
        pending: false,
        retrying: false,
      }),
    );

    expectInvalidControl(markup, "select", "kind");
    expectInvalidControl(markup, "input", "sortOrder");
    expectInvalidControl(markup, "input", "name");
    expectInvalidControl(markup, "input", "slug");
    for (const message of Object.values(fieldErrors ?? {})) {
      expect(markup).toContain(message);
    }
    expect(markup.match(/role="alert"/gu)).toHaveLength(4);
  });

  it("announces the retained taxonomy state after a delayed archive response", () => {
    const retained = {
      ...taxonomy,
      active: true,
      updatedAt: "2026-09-04T10:01:00.000Z",
      version: 3,
    } satisfies BackofficeTaxonomyItem;

    const notice = taxonomyStatusNoticeFromRetainedState(taxonomy, retained);

    expect(notice).toBe(
      "O estado mais recente de “Podcast” foi preservado: ativa para novas seleções.",
    );
    expect(notice).not.toContain("arquivada");
  });

  it("suppresses taxonomy notices when no retained version can prove the result", () => {
    expect(taxonomyStatusNoticeFromRetainedState(taxonomy, undefined)).toBeUndefined();
    expect(
      taxonomyUpsertNoticeFromRetainedState(taxonomy, { ...taxonomy, version: 1 }),
    ).toBeUndefined();
  });

  it("announces the refreshed account after a delayed suspension response", () => {
    const retained = {
      ...user,
      accountVersion: 3,
      status: "active",
    } satisfies BackofficeUserSummary;

    const notice = userStatusNoticeFromRetainedState(user, retained);

    expect(notice).toBe("O estado mais recente da conta foi preservado: conta ativa.");
    expect(notice).not.toContain("suspensa");
  });

  it("uses the normal success copy only when the command result remains retained", () => {
    expect(taxonomyStatusNoticeFromRetainedState(taxonomy, taxonomy)).toBe(
      "“Podcast” arquivada; referências históricas preservadas.",
    );
    expect(userStatusNoticeFromRetainedState(user, user)).toBe(
      "Usuário suspenso e sessões operacionais encerradas.",
    );
    expect(userStatusNoticeFromRetainedState(user, undefined)).toBeUndefined();
  });
});
