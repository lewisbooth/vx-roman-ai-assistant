import {
  cloneElement,
  createElement,
  isValidElement,
  memo,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { normalizeUri } from "micromark-util-sanitize-uri";
import type { StorefrontNavigation } from "../navigation/shared";
import { isPdfLink, StorefrontLink } from "./StorefrontLink";
import { bufferIncompleteMarkdownLinks } from "./streaming-markdown";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean | null;
  lang?: string | null;
  children?: MarkdownNode[];
};

/** Remove source links with their captions, including saved replies from the old UI. */
function hidePdfLinks(root: MarkdownNode) {
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
function proseParagraphs(node: MarkdownNode) {
  if (!node.children || node.type === "list") return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "paragraph") {
      proseParagraphs(child);
      return [child];
    }
    return proseLines(child.children ?? [])
      .map(trimProseStart)
      .filter((line) =>
        line.some((item) => item.type !== "text" || item.value?.trim()),
      )
      .map((children) => ({ ...child, children }));
  });
}

/** Match CommonMark URI encoding and the previous renderer's protocol policy. */
function markdownUrl(value: string): string {
  const url = normalizeUri(value);
  const colon = url.indexOf(":");
  const path = url.search(/[/?#]/);
  return colon === -1 ||
    (path !== -1 && colon > path) ||
    /^(https?|ircs?|mailto|xmpp)$/i.test(url.slice(0, colon))
    ? url
    : "";
}

/** Render only the supported CommonMark nodes, without accepting HTML or images. */
function renderMarkdown(root: MarkdownNode): ReactNode[] {
  const definitions = new Map<string, MarkdownNode>();
  function collect(node: MarkdownNode) {
    if (node.type === "definition" && node.identifier) {
      const identifier = node.identifier.toUpperCase();
      if (!definitions.has(identifier)) definitions.set(identifier, node);
    }
    node.children?.forEach(collect);
  }
  collect(root);

  function keyed(nodes: ReactNode[]): ReactNode[] {
    const counts = new Map<ReactElement["type"], number>();
    return nodes.map((node) => {
      if (!isValidElement(node)) return node;
      const count = counts.get(node.type) ?? 0;
      counts.set(node.type, count + 1);
      return cloneElement(node, { key: `${node.type}-${count}` });
    });
  }

  function children(node: MarkdownNode): ReactNode[] {
    const items = node.children ?? [];
    return keyed(items.flatMap((child, index) => {
      const result = render(child);
      if (items[index - 1]?.type !== "break") return result;
      // CommonMark removes ASCII indentation after a hard break, including
      // the first text child of inline code, emphasis or a link.
      if (typeof result === "string") return result.replace(/^[ \t]+/, "");
      if (isValidElement<{ children?: ReactNode }>(result)) {
        const content = Array.isArray(result.props.children)
          ? result.props.children
          : [result.props.children];
        if (typeof content[0] === "string")
          return cloneElement(result, {}, content[0].replace(/^[ \t]+/, ""), ...content.slice(1));
      }
      return result;
    }));
  }

  // Preserve the block separators used by CommonMark's HTML rendering. They
  // count towards the existing reveal budget, including around nested lists.
  function blocks(
    node: MarkdownNode,
    surround = false,
    loose = false,
  ): ReactNode[] {
    const items = (node.children ?? []).filter(
      (child) => child.type !== "definition",
    );
    return keyed([
      ...(surround ? ["\n"] : []),
      ...items.flatMap((child, index) => [
        ...(index ? ["\n"] : []),
        render(child, loose),
      ]),
      ...(surround && items.length ? ["\n"] : []),
    ]);
  }

  function render(node: MarkdownNode, loose = false): ReactNode {
    switch (node.type) {
      case "root":
        return blocks(node);
      case "text":
        // Trim indentation at soft line breaks, preserving outer/internal spaces.
        return (node.value ?? "").replace(/[ \t]*(\r?\n|\r)[ \t]*/g, "$1");
      case "paragraph":
        return <p>{children(node)}</p>;
      case "strong":
        return <strong>{children(node)}</strong>;
      case "emphasis":
        return <em>{children(node)}</em>;
      case "heading": {
        const tag = `h${node.depth}` as
          | "h1"
          | "h2"
          | "h3"
          | "h4"
          | "h5"
          | "h6";
        return createElement(tag, null, ...children(node));
      }
      case "blockquote":
        return <blockquote>{blocks(node, true)}</blockquote>;
      case "list": {
        const listLoose =
          !!node.spread ||
          (node.children ?? []).some(
            (item) => item.spread ?? (item.children ?? []).length > 1,
          );
        const items = blocks(node, true, listLoose);
        return node.ordered ? (
          <ol start={node.start === 1 ? undefined : node.start ?? undefined}>
            {items}
          </ol>
        ) : (
          <ul>{items}</ul>
        );
      }
      case "listItem": {
        const items = (node.children ?? []).filter(
          (child) => child.type !== "definition",
        );
        const content = items.flatMap((child, index) => [
          ...(loose || index || child.type !== "paragraph" ? ["\n"] : []),
          ...(child.type === "paragraph" && !loose
            ? children(child)
            : [render(child)]),
        ]);
        if (
          items.length &&
          (loose || items[items.length - 1].type !== "paragraph")
        )
          content.push("\n");
        return <li>{keyed(content)}</li>;
      }
      case "inlineCode":
        return <code>{(node.value ?? "").replace(/\r?\n|\r/g, " ")}</code>;
      case "code":
        return (
          <pre>
            <code
              className={
                node.lang ? `language-${node.lang.split(/\s+/)[0]}` : undefined
              }
            >
              {node.value ? `${node.value}\n` : undefined}
            </code>
          </pre>
        );
      case "break":
        return [<br key="br-0" />, "\n"];
      case "thematicBreak":
        return <hr />;
      case "link":
      case "linkReference": {
        const target =
          node.type === "link"
            ? node
            : definitions.get((node.identifier ?? "").toUpperCase());
        return <a href={markdownUrl(target?.url ?? "")}>{children(node)}</a>;
      }
      default:
        return null;
    }
  }

  return blocks(root);
}

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
  const tree = fromMarkdown(pending ? bufferIncompleteMarkdownLinks(text) : text);
  hidePdfLinks(tree);
  proseParagraphs(tree);
  const nodes = prepareNodes(renderMarkdown(tree));
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
  const reserving = count < content.length;
  // The full safe tree sizes the reply once per source update, not per tick.
  // Keep the visible tree mounted so links retain focus as the reveal finishes.
  const reserved = useMemo(
    () => reserving ? revealNodes(content.nodes, content.length, navigation) : null,
    [content, navigation, reserving],
  );

  return (
    <div className="roman-reply-layout">
      <div className="roman-rich-text">
        {revealNodes(content.nodes, count, navigation)}
      </div>
      {reserving && (
        <div
          className="roman-rich-text roman-reply-reservation"
          aria-hidden="true"
          {...{ inert: "" }}
        >
          {reserved}
        </div>
      )}
    </div>
  );
});
