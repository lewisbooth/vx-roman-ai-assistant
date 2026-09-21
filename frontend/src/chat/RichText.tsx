import {
  cloneElement,
  isValidElement,
  memo,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import type { StorefrontNavigation } from "../navigation/shared";
import { isPdfLink, StorefrontLink } from "./StorefrontLink";
import { bufferIncompleteMarkdownLinks } from "./streaming-markdown";

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
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
};

/** Remove source links with their captions, including saved replies from the old UI. */
function remarkHidePdfLinks() {
  return function transform(root: MarkdownNode) {
    const pdfReferences = new Set<string>();
    function collect(node: MarkdownNode) {
      if (node.type === "definition" && node.url && isPdfLink(node.url))
        pdfReferences.add(node.identifier!);
      node.children?.forEach(collect);
    }
    collect(root);

    function keep(node: MarkdownNode): boolean {
      if (
        (node.url && isPdfLink(node.url)) ||
        (node.type === "linkReference" && pdfReferences.has(node.identifier!))
      )
        return false;
      if (node.type === "text") {
        const previous = node.value ?? "";
        node.value = previous.replace(
          /(?:https?:\/\/|\/cdn\/shop\/files\/)[^\s<>]+/gi,
          (url) => (isPdfLink(url.replace(/[),.;!?]+$/, "")) ? "" : url),
        );
        return node.value === previous || !!node.value.trim();
      }
      if (node.children) {
        const previousLength = node.children.length;
        node.children = node.children.filter(keep);
        return (
          node.children.length === previousLength ||
          node.children.some(
            (child) =>
              child.type !== "text" || /[\p{L}\p{N}]/u.test(child.value ?? ""),
          )
        );
      }
      return true;
    }
    keep(root);
  };
}

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

function trimProseStart(children: MarkdownNode[]): MarkdownNode[] {
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child.type === "text") {
      const value = (child.value ?? "").trimStart();
      if (value) return [{ ...child, value }, ...children.slice(index + 1)];
    } else if (child.children) {
      const trimmed = trimProseStart(child.children);
      if (trimmed.length)
        return [{ ...child, children: trimmed }, ...children.slice(index + 1)];
    } else {
      // Inline code owns its whitespace, even at the start of a paragraph.
      return children.slice(index);
    }
  }
  return [];
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
        .map(trimProseStart)
        .filter((line) =>
          line.some((item) => item.type !== "text" || item.value?.trim()),
        )
        .map((children) => ({ ...child, children }));
    });
  };
}

const remarkPlugins = [remarkHidePdfLinks, remarkProseParagraphs];

type PreparedNode =
  | { text: string; ends: number[]; length: number }
  | {
      element: ReactElement<{ children?: ReactNode; href?: string }>;
      children: PreparedNode[];
      length: number;
    };

export type PreparedRichText = {
  /** Rendered graphemes and line breaks, after Markdown/PDF filtering. */
  length: number;
  nodes: PreparedNode[];
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function prepareNodes(value: ReactNode): PreparedNode[] {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    const ends = Array.from(
      graphemes.segment(text),
      ({ index, segment }) => index + segment.length,
    );
    return [{ text, ends, length: ends.length }];
  }
  if (Array.isArray(value)) return value.flatMap(prepareNodes);
  if (!isValidElement<{ children?: ReactNode; href?: string }>(value))
    return [];
  const children = prepareNodes(value.props.children);
  const length =
    value.type === "br" || value.type === "hr"
      ? 1
      : children.reduce((total, child) => total + child.length, 0);
  return [{ element: value, children, length }];
}

/** Parse once per source update; reveal ticks only trim the safe rendered tree. */
export function prepareRichText(
  text: string,
  pending = false,
): PreparedRichText {
  // react-markdown's synchronous export is a hook-free parse/render function.
  const nodes = prepareNodes(
    Markdown({
      skipHtml: true,
      remarkPlugins,
      allowedElements,
      children: pending ? bufferIncompleteMarkdownLinks(text) : text,
    }),
  );
  return {
    nodes,
    length: nodes.reduce((total, node) => total + node.length, 0),
  };
}

function revealNodes(
  nodes: PreparedNode[],
  visibleCharacters: number,
  navigation: StorefrontNavigation,
): ReactNode[] {
  let remaining = visibleCharacters;
  return nodes.map((node, index) => {
    if (remaining <= 0 || !node.length) return null;
    const count = Math.min(remaining, node.length);
    remaining -= count;
    if ("text" in node)
      return count >= node.length
        ? node.text
        : node.text.slice(0, node.ends[count - 1]);
    const { element } = node;
    const key = element.key ?? index;
    const children = revealNodes(node.children, count, navigation);
    if (element.type === "a")
      return element.props.href?.trim() ? (
        <StorefrontLink
          key={key}
          url={element.props.href}
          navigation={navigation}
        >
          {children}
        </StorefrontLink>
      ) : (
        <span key={key}>{children}</span>
      );
    return cloneElement(element, { key }, ...children);
  });
}

export const RichText = memo(function RichText({
  text,
  navigation,
  pending = false,
  prepared,
  visibleCharacters,
}: {
  text: string;
  navigation: StorefrontNavigation;
  pending?: boolean;
  prepared?: PreparedRichText;
  visibleCharacters?: number;
}) {
  const content = useMemo(
    () => prepared ?? prepareRichText(text, pending),
    [prepared, text, pending],
  );
  const count =
    visibleCharacters === undefined
      ? content.length
      : Math.max(0, Math.floor(visibleCharacters));

  return (
    <div className="roman-rich-text">
      {revealNodes(content.nodes, count, navigation)}
    </div>
  );
});
