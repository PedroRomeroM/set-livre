import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegalMarkdown } from "../../src/domains/legal/components/legal-markdown";
import {
  parseLegalMarkdown,
  parseLegalMarkdownInline,
  safeLegalMarkdownHref,
} from "../../src/domains/legal/components/legal-markdown-parser";

describe("legal Markdown", () => {
  it("preserves the supported block semantics and omits the duplicated document title", () => {
    const markdown = [
      "# Termos de uso",
      "",
      "Introdução em uma",
      "segunda linha.",
      "",
      "## Seus direitos ##",
      "",
      "- Primeiro direito",
      "+ Segundo direito",
      "",
      "3. Terceira obrigação",
      "4) Quarta obrigação",
      "",
      "### Detalhes",
    ].join("\r\n");

    expect(parseLegalMarkdown(markdown, "Termos de uso")).toEqual([
      { kind: "paragraph", text: "Introdução em uma segunda linha." },
      { kind: "heading", level: 2, text: "Seus direitos" },
      {
        items: ["Primeiro direito", "Segundo direito"],
        kind: "list",
        ordered: false,
        start: 1,
      },
      {
        items: ["Terceira obrigação", "Quarta obrigação"],
        kind: "list",
        ordered: true,
        start: 3,
      },
      { kind: "heading", level: 3, text: "Detalhes" },
    ]);
  });

  it("keeps an unmatched Markdown H1 inside the page heading hierarchy", () => {
    expect(parseLegalMarkdown("# Seção independente", "Política de Privacidade")).toEqual([
      { kind: "heading", level: 2, text: "Seção independente" },
    ]);
  });

  it("recognizes strong, emphasis and allowlisted links as explicit inline nodes", () => {
    expect(
      parseLegalMarkdownInline(
        "Leia **com atenção**, consulte *os detalhes*, [privacidade](/privacidade#dados) e [referência](https://docs.example.test/legal).",
      ),
    ).toEqual([
      { kind: "text", text: "Leia " },
      { children: [{ kind: "text", text: "com atenção" }], kind: "strong" },
      { kind: "text", text: ", consulte " },
      { children: [{ kind: "text", text: "os detalhes" }], kind: "emphasis" },
      { kind: "text", text: ", " },
      {
        children: [{ kind: "text", text: "privacidade" }],
        href: "/privacidade#dados",
        kind: "link",
      },
      { kind: "text", text: " e " },
      {
        children: [{ kind: "text", text: "referência" }],
        href: "https://docs.example.test/legal",
        kind: "link",
      },
      { kind: "text", text: "." },
    ]);
  });

  it("rejects unsafe link destinations", () => {
    for (const candidate of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "http://docs.example.test/legal",
      "//attacker.example/legal",
      "https://user:secret@docs.example.test/legal",
      "/\\attacker.example/legal",
      "/%2f%2fattacker.example/legal",
      "/%5cattacker.example/legal",
      "/%2e%2e//attacker.example/legal",
    ]) {
      expect(safeLegalMarkdownHref(candidate), candidate).toBeNull();
    }
  });

  it("renders the safe subset with semantic elements and escaped hostile input", () => {
    const bodyMarkdown = [
      "# Termos de uso",
      "",
      "## Direitos",
      "",
      "Parágrafo com **ênfase forte**, *ênfase simples*, [link interno](/privacidade) e [link HTTPS](https://docs.example.test/legal).",
      "",
      "- Item com __destaque__",
      "- [rótulo seguro](javascript:alert(1)) <script>globalThis.compromised = true</script>",
      "- [dados rejeitados](data:text/html,unsafe)",
      "- [credencial rejeitada](https://user:secret@docs.example.test/legal)",
      "- [**[interno](/privacidade)**](/termos)",
      "",
      "3. Terceira obrigação",
      "4. Quarta obrigação",
    ].join("\n");

    const html = renderToStaticMarkup(
      createElement(LegalMarkdown, { bodyMarkdown, documentTitle: "Termos de uso" }),
    );

    expect(html).toContain("<h2>Direitos</h2>");
    expect(html).toContain("<p>Parágrafo com <strong>ênfase forte</strong>");
    expect(html).toContain("<em>ênfase simples</em>");
    expect(html).toContain('<a href="/privacidade">link interno</a>');
    expect(html).toContain('<a href="https://docs.example.test/legal">link HTTPS</a>');
    expect(html).toContain('<a href="/termos"><strong>[interno](/privacidade)</strong></a>');
    expect(html.match(/<a /gu)).toHaveLength(3);
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>destaque</strong>");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("rótulo seguro");
    expect(html).toContain("dados rejeitados");
    expect(html).toContain("credencial rejeitada");
    expect(html).toContain("&lt;script&gt;globalThis.compromised = true&lt;/script&gt;");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("user:secret");
    expect(html).not.toContain("<script>");

    const rendererSource = readFileSync(
      new URL("../../src/domains/legal/components/legal-markdown.ts", import.meta.url),
      "utf8",
    );
    expect(rendererSource).not.toContain("dangerouslySetInnerHTML");
  });
});
