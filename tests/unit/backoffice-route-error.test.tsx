import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import BackofficeError from "../../apps/backoffice/src/app/error";

it("renders a neutral, hydration-safe fallback without publishing the failed lookup", () => {
  const retry = vi.fn();
  const error = Object.assign(new Error("private.get_backoffice_session qa_private@example.test"), {
    digest: "internal-digest",
  });
  const queryClient = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BackofficeError, { error, retry }),
      ),
    );
    expect(html).toContain("Não foi possível carregar o backoffice");
    expect(html).toContain("conteúdo privado permanece fechado");
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button\b[^>]*disabled=""/u);
    expect(html).toContain("Tentar novamente");
    expect(html).toContain("<noscript>");
    expect(html).not.toMatch(
      /private\.get_backoffice_session|qa_private|internal-digest|<nav|<form/u,
    );
    expect(retry).not.toHaveBeenCalled();
  } finally {
    queryClient.clear();
  }
});
