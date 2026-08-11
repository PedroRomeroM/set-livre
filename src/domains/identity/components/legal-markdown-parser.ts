type LegalMarkdownHeadingLevel = 2 | 3 | 4 | 5 | 6;

type LegalMarkdownHeadingBlock = {
  kind: "heading";
  level: LegalMarkdownHeadingLevel;
  text: string;
};

type LegalMarkdownListBlock = {
  items: readonly string[];
  kind: "list";
  ordered: boolean;
  start: number;
};

type LegalMarkdownParagraphBlock = {
  kind: "paragraph";
  text: string;
};

export type LegalMarkdownBlock =
  LegalMarkdownHeadingBlock | LegalMarkdownListBlock | LegalMarkdownParagraphBlock;

type LegalMarkdownInlineContainer = {
  children: readonly LegalMarkdownInlineNode[];
  kind: "emphasis" | "strong";
};

type LegalMarkdownInlineLink = {
  children: readonly LegalMarkdownInlineNode[];
  href: string;
  kind: "link";
};

type LegalMarkdownInlineText = {
  kind: "text";
  text: string;
};

export type LegalMarkdownInlineNode =
  LegalMarkdownInlineContainer | LegalMarkdownInlineLink | LegalMarkdownInlineText;

type MutableList = {
  items: string[];
  ordered: boolean;
  start: number;
};

const atxHeadingPattern = /^\s{0,3}(#{1,6})(?:[\t ]+|$)(.*)$/u;
const orderedListItemPattern = /^\s{0,3}(\d{1,9})[.)][\t ]+(.*)$/u;
const unorderedListItemPattern = /^\s{0,3}[-+*][\t ]+(.*)$/u;
const legalMarkdownBaseUrl = "https://set-livre.invalid";
const maximumInlineDepth = 8;

function normalizedHeadingText(value: string) {
  return value.replace(/[\t ]+#+[\t ]*$/u, "").trim();
}

function normalizedTitle(value: string) {
  return value.trim().toLocaleLowerCase("pt-BR");
}

function bodyHeadingLevel(markdownLevel: number): LegalMarkdownHeadingLevel {
  switch (markdownLevel) {
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    case 6:
      return 6;
    default:
      return 2;
  }
}

function hasUnsafeHrefCharacter(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === "\\" || codePoint === undefined || codePoint <= 0x20 || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

export function safeLegalMarkdownHref(candidate: string): string | null {
  if (
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    hasUnsafeHrefCharacter(candidate)
  ) {
    return null;
  }

  if (candidate.startsWith("/")) {
    const lowerCandidate = candidate.toLocaleLowerCase("en-US");
    if (
      candidate.startsWith("//") ||
      lowerCandidate.includes("%2f") ||
      lowerCandidate.includes("%5c")
    ) {
      return null;
    }

    try {
      const url = new URL(candidate, legalMarkdownBaseUrl);
      if (url.origin !== legalMarkdownBaseUrl || url.username !== "" || url.password !== "") {
        return null;
      }

      const normalizedHref = `${url.pathname}${url.search}${url.hash}`;
      return normalizedHref.startsWith("//") ? null : normalizedHref;
    } catch {
      return null;
    }
  }

  if (!candidate.toLocaleLowerCase("en-US").startsWith("https://")) {
    return null;
  }

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname.length === 0 ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function appendInlineNode(nodes: LegalMarkdownInlineNode[], node: LegalMarkdownInlineNode) {
  const previous = nodes.at(-1);
  if (node.kind === "text" && previous?.kind === "text") {
    nodes[nodes.length - 1] = { kind: "text", text: previous.text + node.text };
    return;
  }

  nodes.push(node);
}

function appendInlineText(nodes: LegalMarkdownInlineNode[], text: string) {
  if (text.length > 0) {
    appendInlineNode(nodes, { kind: "text", text });
  }
}

function findLinkDestinationEnd(value: string, startIndex: number) {
  let nestedParentheses = 0;
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") {
      nestedParentheses += 1;
      continue;
    }

    if (character === ")") {
      if (nestedParentheses === 0) {
        return index;
      }
      nestedParentheses -= 1;
    }
  }

  return -1;
}

function findLinkLabelEnd(value: string, startIndex: number) {
  let nestedBrackets = 0;
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      nestedBrackets += 1;
      continue;
    }
    if (character !== "]") {
      continue;
    }
    if (nestedBrackets > 0) {
      nestedBrackets -= 1;
      continue;
    }
    if (value[index + 1] === "(") {
      return index;
    }
  }

  return -1;
}

function parseLegalMarkdownInlineAtDepth(
  value: string,
  depth: number,
  allowLinks: boolean,
): readonly LegalMarkdownInlineNode[] {
  if (depth >= maximumInlineDepth) {
    return value.length === 0 ? [] : [{ kind: "text", text: value }];
  }

  const nodes: LegalMarkdownInlineNode[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const current = value[cursor];

    if (current === "\\" && cursor + 1 < value.length) {
      const escaped = value[cursor + 1];
      if (escaped !== undefined && "\\*_[]".includes(escaped)) {
        appendInlineText(nodes, escaped);
        cursor += 2;
        continue;
      }
    }

    if (allowLinks && current === "[") {
      const labelEnd = findLinkLabelEnd(value, cursor + 1);
      if (labelEnd > cursor + 1) {
        const destinationStart = labelEnd + 2;
        const destinationEnd = findLinkDestinationEnd(value, destinationStart);
        if (destinationEnd > destinationStart) {
          const label = value.slice(cursor + 1, labelEnd);
          const href = safeLegalMarkdownHref(value.slice(destinationStart, destinationEnd));
          const children = parseLegalMarkdownInlineAtDepth(label, depth + 1, false);
          if (href === null) {
            for (const child of children) {
              appendInlineNode(nodes, child);
            }
          } else {
            appendInlineNode(nodes, { children, href, kind: "link" });
          }
          cursor = destinationEnd + 1;
          continue;
        }
      }
    }

    const strongDelimiter =
      value.startsWith("**", cursor) || value.startsWith("__", cursor)
        ? value.slice(cursor, cursor + 2)
        : undefined;
    if (strongDelimiter !== undefined) {
      const end = value.indexOf(strongDelimiter, cursor + strongDelimiter.length);
      if (end > cursor + strongDelimiter.length) {
        const inner = value.slice(cursor + strongDelimiter.length, end);
        if (inner === inner.trim()) {
          appendInlineNode(nodes, {
            children: parseLegalMarkdownInlineAtDepth(inner, depth + 1, allowLinks),
            kind: "strong",
          });
          cursor = end + strongDelimiter.length;
          continue;
        }
      }
    }

    const emphasisDelimiter =
      (current === "*" || current === "_") && value[cursor + 1] !== current ? current : undefined;
    if (emphasisDelimiter !== undefined) {
      const end = value.indexOf(emphasisDelimiter, cursor + 1);
      if (end > cursor + 1) {
        const inner = value.slice(cursor + 1, end);
        if (inner === inner.trim()) {
          appendInlineNode(nodes, {
            children: parseLegalMarkdownInlineAtDepth(inner, depth + 1, allowLinks),
            kind: "emphasis",
          });
          cursor = end + 1;
          continue;
        }
      }
    }

    appendInlineText(nodes, current ?? "");
    cursor += 1;
  }

  return nodes;
}

export function parseLegalMarkdownInline(value: string): readonly LegalMarkdownInlineNode[] {
  return parseLegalMarkdownInlineAtDepth(value, 0, true);
}

export function parseLegalMarkdown(
  bodyMarkdown: string,
  documentTitle: string,
): readonly LegalMarkdownBlock[] {
  const blocks: LegalMarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let pendingList: MutableList | undefined;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
    paragraphLines = [];
  };

  const flushList = () => {
    if (pendingList === undefined) {
      return;
    }

    blocks.push({
      items: pendingList.items,
      kind: "list",
      ordered: pendingList.ordered,
      start: pendingList.start,
    });
    pendingList = undefined;
  };

  const appendListItem = (ordered: boolean, start: number, text: string) => {
    flushParagraph();

    if (pendingList === undefined || pendingList.ordered !== ordered) {
      flushList();
      pendingList = { items: [], ordered, start };
    }

    pendingList.items.push(text);
  };

  for (const rawLine of bodyMarkdown.replace(/\r\n?/gu, "\n").split("\n")) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = atxHeadingPattern.exec(rawLine);
    if (headingMatch !== null) {
      const headingMarker = headingMatch[1];
      const headingSource = headingMatch[2];
      if (headingMarker !== undefined && headingSource !== undefined) {
        const text = normalizedHeadingText(headingSource);
        if (text.length > 0) {
          flushParagraph();
          flushList();

          const isDuplicateDocumentTitle =
            blocks.length === 0 &&
            headingMarker.length === 1 &&
            normalizedTitle(text) === normalizedTitle(documentTitle);
          if (!isDuplicateDocumentTitle) {
            blocks.push({
              kind: "heading",
              level: bodyHeadingLevel(headingMarker.length),
              text,
            });
          }
          continue;
        }
      }
    }

    const unorderedMatch = unorderedListItemPattern.exec(rawLine);
    if (unorderedMatch !== null) {
      const text = unorderedMatch[1]?.trim();
      if (text !== undefined && text.length > 0) {
        appendListItem(false, 1, text);
        continue;
      }
    }

    const orderedMatch = orderedListItemPattern.exec(rawLine);
    if (orderedMatch !== null) {
      const startText = orderedMatch[1];
      const text = orderedMatch[2]?.trim();
      if (startText !== undefined && text !== undefined && text.length > 0) {
        appendListItem(true, Number.parseInt(startText, 10), text);
        continue;
      }
    }

    flushList();
    paragraphLines.push(trimmedLine);
  }

  flushParagraph();
  flushList();
  return blocks;
}
