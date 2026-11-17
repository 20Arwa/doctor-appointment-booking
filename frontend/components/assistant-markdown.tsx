import { Fragment, createElement, type ReactNode } from "react";

function normalizeMarkdownEscapes(value: string): string {
  return value.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1");
}

function inlineMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) nodes.push(value.slice(lastIndex, match.index));
    const token = match[0];
    const strong = token.startsWith("**") || token.startsWith("__");
    const markerLength = strong ? 2 : 1;
    const content = token.slice(markerLength, -markerLength);
    nodes.push(strong ? createElement("strong", { key: `${match.index}-strong` }, content) : createElement("em", { key: `${match.index}-em` }, content));
    lastIndex = match.index + token.length;
  }
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes;
}

function renderParagraph(lines: string[], key: string): ReactNode {
  return createElement("p", { key, className: "whitespace-pre-wrap" }, ...inlineMarkdown(lines.join(" ")));
}

export function AssistantMarkdown({ content }: { content: string }) {
  const lines = normalizeMarkdownEscapes(content).split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) { blocks.push(renderParagraph(paragraph, `p-${blocks.length}`)); paragraph = []; }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(orderedList ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      index -= 1;
      const listTag = orderedList ? "ol" : "ul";
      const listItems = items.map((item, itemIndex) => createElement("li", { key: `item-${itemIndex}` }, ...inlineMarkdown(item)));
      blocks.push(createElement(listTag, { key: `list-${blocks.length}`, className: `${orderedList ? "list-decimal" : "list-disc"} ml-5 space-y-1` }, ...listItems));
      continue;
    }
    if (!line.trim()) { flushParagraph(); continue; }
    paragraph.push(line);
  }
  flushParagraph();
  return createElement(Fragment, null, ...blocks);
}
