import { memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import type { StorefrontNavigation } from "../navigation/shared";
import { StorefrontLink } from "./StorefrontLink";

const allowedElements = [
  "p",
  "br",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "code",
  "hr",
];

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

function proseLines(children: MarkdownNode[]): MarkdownNode[][] {
  const lines: MarkdownNode[][] = [[]];
  for (const child of children) {
    const segments =
      child.type === "text"
        ? (child.value ?? "")
            .split(/\r?\n/)
            .map((value) => (value ? [{ ...child, value }] : []))
        : child.type === "break"
          ? [[], []]
          : child.children
            ? proseLines(child.children).map((line) =>
                line.length ? [{ ...child, children: line }] : [],
              )
            : [[child]];
    segments.forEach((segment, index) => {
      if (index) lines.push([]);
      lines[lines.length - 1].push(...segment);
    });
  }
  return lines;
}

/** Authored prose returns become paragraphs; list/code layout stays Markdown-owned. */
function remarkProseParagraphs() {
  return function transform(node: MarkdownNode) {
    if (!node.children || node.type === "list") return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "paragraph") {
        transform(child);
        return [child];
      }
      return proseLines(child.children ?? [])
        .filter((line) =>
          line.some((item) => item.type !== "text" || item.value?.trim()),
        )
        .map((children) => ({ ...child, children }));
    });
  };
}

const remarkPlugins = [remarkProseParagraphs];

export const RichText = memo(function RichText({
  text,
  navigation,
}: {
  text: string;
  navigation: StorefrontNavigation;
}) {
  // Keep link components stable while streamed text updates, preserving focus.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) =>
        href?.trim() ? (
          <StorefrontLink url={href} navigation={navigation}>
            {children}
          </StorefrontLink>
        ) : (
          <span>{children}</span>
        ),
    }),
    [navigation],
  );

  return (
    <div className="roman-rich-text">
      <Markdown
        skipHtml
        remarkPlugins={remarkPlugins}
        allowedElements={allowedElements}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
