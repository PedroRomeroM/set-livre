import { createElement, Fragment, type ReactNode } from "react";

import type { LegalMarkdownBlock, LegalMarkdownInlineNode } from "./legal-markdown-parser";
import { parseLegalMarkdown, parseLegalMarkdownInline } from "./legal-markdown-parser";

type LegalMarkdownProps = {
  bodyMarkdown: string;
  className?: string | undefined;
  documentTitle: string;
};

function renderInline(nodes: readonly LegalMarkdownInlineNode[]): readonly ReactNode[] {
  return nodes.map((node, nodeIndex) => {
    const key = `${node.kind}-${nodeIndex}`;
    switch (node.kind) {
      case "text":
        return createElement(Fragment, { key }, node.text);
      case "strong":
        return createElement("strong", { key }, renderInline(node.children));
      case "emphasis":
        return createElement("em", { key }, renderInline(node.children));
      case "link":
        return createElement("a", { href: node.href, key }, renderInline(node.children));
    }
  });
}

function renderBlock(block: LegalMarkdownBlock, blockIndex: number) {
  const blockKey = `${block.kind}-${blockIndex}`;
  if (block.kind === "heading") {
    return createElement(
      `h${block.level}`,
      { key: blockKey },
      renderInline(parseLegalMarkdownInline(block.text)),
    );
  }

  if (block.kind === "paragraph") {
    return createElement(
      "p",
      { key: blockKey },
      renderInline(parseLegalMarkdownInline(block.text)),
    );
  }

  const items = block.items.map((item, itemIndex) =>
    createElement(
      "li",
      { key: `${blockKey}-${itemIndex}` },
      renderInline(parseLegalMarkdownInline(item)),
    ),
  );
  return block.ordered
    ? createElement(
        "ol",
        { key: blockKey, start: block.start === 1 ? undefined : block.start },
        items,
      )
    : createElement("ul", { key: blockKey }, items);
}

export function LegalMarkdown({ bodyMarkdown, className, documentTitle }: LegalMarkdownProps) {
  return createElement(
    "div",
    { className },
    parseLegalMarkdown(bodyMarkdown, documentTitle).map(renderBlock),
  );
}
